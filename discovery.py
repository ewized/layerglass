"""Bounded, credential-free camera discovery on explicitly local networks."""

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from dataclasses import dataclass
import ipaddress
import math
import os
import socket
import ssl
import threading
import time
import uuid
from urllib.parse import urlsplit

from providers import APPROVED, PROVIDERS, approved_camera, describe, discover_names, discovery_ports, endpoint, probe
from providers.identification import IdentificationRace


LAN_NETWORKS = tuple(ipaddress.ip_network(cidr) for cidr in
                     ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))


@dataclass
class ProbeMemo:
    item: dict | None
    failures: int
    retry_at: float
    discard_at: float


class ProbeCache:
    """Small, process-local public results; no credentials or background retries."""
    SUCCESS_TTL = 20
    FAILURE_BASE = 15
    FAILURE_MAX = 60
    HISTORY_TTL = 300
    LIMIT = 8192

    def __init__(self):
        self.entries = OrderedDict()

    def get(self, key, now):
        entry = self.entries.get(key)
        if not entry:
            return False, None
        if now >= entry.discard_at:
            del self.entries[key]
            return False, None
        self.entries.move_to_end(key)
        return (True, deepcopy(entry.item)) if now < entry.retry_at else (False, None)

    def put(self, key, item, now):
        previous = self.entries.get(key)
        failures = 0 if item else min(3, (previous.failures if previous and now < previous.discard_at else 0) + 1)
        delay = self.SUCCESS_TTL if item else min(self.FAILURE_MAX, self.FAILURE_BASE * 2 ** (failures - 1))
        self.entries[key] = ProbeMemo(deepcopy(item), failures, now + delay, now + self.HISTORY_TTL)
        self.entries.move_to_end(key)
        while len(self.entries) > self.LIMIT:
            self.entries.popitem(last=False)


def scan_networks(source, configured):
    if configured:
        values = configured.split(',')
    else:
        host = urlsplit(source).hostname if source else None
        try:
            address = ipaddress.ip_address(socket.gethostbyname(host)) if host else None
        except (OSError, ValueError):
            address = None
        values = [f'{address}/24'] if address and any(address in net for net in LAN_NETWORKS) else []
    try:
        networks = tuple(dict.fromkeys(ipaddress.ip_network(value.strip(), strict=False)
                                     for value in values))
    except ValueError:
        raise ValueError('DISCOVERY_CIDRS must contain comma-separated IPv4 LAN subnets.') from None
    if any(net.version != 4 or not any(net.subnet_of(lan) for lan in LAN_NETWORKS)
           for net in networks):
        raise ValueError('Discovery is limited to private IPv4 LAN subnets.')
    if sum(net.num_addresses for net in networks) > 4096:
        raise ValueError('Discovery is limited to 4096 addresses; use smaller subnets.')
    return networks


class Discovery:
    PROBE_WORKERS = 48
    NAME_TTL = 20
    SCAN_INTERVAL = 10
    ERROR_BACKOFF_MAX = 120

    def __init__(self, source='', cidrs='', *, clock=None):
        self.clock = clock or time.monotonic
        self.networks = scan_networks(source, cidrs)
        self.ports = discovery_ports(os.environ.get('DISCOVERY_PORTS', ''))
        if len(self.ports) > 32:
            raise ValueError('Discovery is limited to 32 camera ports, including the configured camera.')
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.state = 'idle'
        self.checked = 0
        self.total = 0
        self.cached = 0
        self.probed = 0
        self.cache = ProbeCache()
        self.priority_hosts = {urlsplit(source).hostname} if source else set()
        self.targets = []
        self.found = []
        self.started = None
        self.completed = None
        self.scan_failures = 0
        self.next_scan_at = 0
        self.retry_at = None
        self.scan_id = None
        self.finished_at = None
        self.identities = {}
        self.name_results = {}
        self.names_checked_at = float('-inf')
        self.names_cached = False
        self.identifier = None
        self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        self.tls.check_hostname = False
        self.tls.verify_mode = ssl.CERT_NONE  # Printers use self-signed certificates.

    def start(self):
        with self.lock:
            now = self.clock()
            if (self.stop_event.is_set() or self.state == 'scanning' or
                    self.thread and self.thread.is_alive() or now < self._next_scan()):
                return False
            self.started = now
            self.retry_at = time.time() + self.SCAN_INTERVAL
            self.completed = None
            self.scan_id = uuid.uuid4().hex
            self.state = 'scanning'
            self.checked = 0
            self.cached = 0
            self.probed = 0
            self.names_cached = False
            self.targets = self._targets()
            self.total = len(self.targets)
            self.thread = threading.Thread(target=self._run, name='camera-discovery', daemon=True)
            self.thread.start()
        return True

    def _next_scan(self):
        return max(self.next_scan_at, self.started + self.SCAN_INTERVAL if self.started is not None else 0)

    def retry_after(self):
        with self.lock:
            return math.ceil(max(0, self._next_scan() - self.clock()))

    def prioritize(self, hosts):
        with self.lock:
            self.priority_hosts.update(host for host in hosts if isinstance(host, str))

    def _targets(self):
        priority = self.priority_hosts | {item['host'] for item in self.found}
        hosts = sorted({str(host) for net in self.networks for host in net.hosts()},
                       key=lambda host: (host not in priority, ipaddress.ip_address(host)))
        return [(host, port, kind) for host in hosts for port, kind in self.ports.items()]

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=6)
        elif self.identifier:
            self.identifier.close()

    def status(self):
        with self.lock:
            now = self.clock()
            return {'state': self.state, 'checked': self.checked, 'total': self.total,
                    'cached': self.cached, 'probed': self.probed, 'names_cached': self.names_cached,
                    'duration_seconds': round(max(0, (self.completed if self.completed is not None else now) - self.started), 3) if self.started is not None else 0,
                    'retry_at': self.retry_at,
                    'scan_id': self.scan_id,
                    'networks': [str(net) for net in self.networks],
                    'finished_at': self.finished_at, 'found': [dict(item) for item in self.found]}

    def _probe(self, host, port, kind):
        if self.stop_event.is_set() or self.ports.get(port) != kind:
            return None
        try:
            candidate = probe(host, port, kind, self.tls)
            if not candidate:
                return None
            with self.lock:
                if self.identifier is None:
                    self.identifier = IdentificationRace(tuple(provider for provider in PROVIDERS if provider.id in APPROVED), self.stop_event)
                identifier = self.identifier
            metadata = identifier.identify(host, port)
            if not metadata or self.stop_event.is_set():
                return None
            item = describe(dict(candidate, **metadata), provider=metadata['provider'])
            return item if approved_camera(item) else None
        except (OSError, ssl.SSLError, ValueError):
            return None

    def _run(self):
        try:
            with ThreadPoolExecutor(max_workers=1, thread_name_prefix='printer-names') as names:
                lookup = names.submit(self._names)
                self._scan(lookup)
        except Exception:
            with self.lock:
                self._finished('idle' if self.stop_event.is_set() else 'error')
        finally:
            if self.identifier:
                self.identifier.close()
                self.identifier = None

    def _names(self):
        with self.lock:
            if self.clock() - self.names_checked_at < self.NAME_TTL:
                self.names_cached = True
                return deepcopy(self.name_results)
            targets = self.priority_hosts | {item['host'] for item in self.found}
            # Source hostnames are only hints; the adapter still restricts all
            # received announcements to the configured LANs.
            allowed = {item[0] for item in self.targets}
            targets.intersection_update(allowed)
        result = discover_names(self.networks, targets, self.stop_event)
        if not self.stop_event.is_set():
            with self.lock:
                self.name_results = deepcopy(result)
                self.names_checked_at = self.clock()
        return result

    def _finished(self, state):
        self.state = state
        self.completed = self.clock()
        self.finished_at = time.time()
        if state == 'error':
            self.scan_failures = min(5, self.scan_failures + 1)
            delay = min(self.ERROR_BACKOFF_MAX, self.SCAN_INTERVAL * 2 ** (self.scan_failures - 1))
            self.next_scan_at = self.completed + delay
            self.retry_at = self.finished_at + delay
        elif state == 'done':
            self.scan_failures = 0
            self.next_scan_at = 0

    def _scan(self, lookup):
        found = []
        pending = []
        with self.lock:
            now = self.clock()
            for target in self.targets:
                hit, item = self.cache.get(target, now)
                if hit and item and not approved_camera(item):
                    hit = False  # A cache entry cannot override the approval policy.
                if hit:
                    self.checked += 1
                    self.cached += 1
                    if item:
                        found.append(item)
                else:
                    pending.append(target)
            if found:
                self.found = list(found)
        # 48 service probes + 16 identity checks cap discovery at 64 connections.
        # Reuse fresh results before scheduling work, and probe known IPs first.
        with ThreadPoolExecutor(max_workers=self.PROBE_WORKERS, thread_name_prefix='camera-probe') as pool:
            futures = {pool.submit(self._probe, *target): target for target in pending}
            for future in as_completed(futures):
                if self.stop_event.is_set():
                    for pending in futures:
                        pending.cancel()
                    break
                item = future.result()
                with self.lock:
                    self.cache.put(futures[future], item, self.clock())
                    self.checked += 1
                    self.probed += 1
                    if item:
                        found.append(item)
                        # Publish candidates immediately; names can follow when
                        # bounded manufacturer lookups finish.
                        self.found = list(found)
        identities = lookup.result()
        with self.lock:
            self.identities.update(identities)
            self.found = []
            for item in found:
                metadata = self.identities.get(item['host'], {})
                enriched = dict(metadata, **item)  # Verified model/serial win over broadcasts.
                if metadata.get('name'):
                    enriched['name'] = metadata['name']
                self.found.append(describe(enriched, provider=item['provider']))
            self._finished('idle' if self.stop_event.is_set() else 'done')
