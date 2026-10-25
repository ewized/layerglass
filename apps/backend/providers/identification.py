"""Bounded, per-scan manufacturer identification races, shared per host."""

from concurrent.futures import ThreadPoolExecutor, as_completed
from collections.abc import Callable
from dataclasses import dataclass
import threading
from .policy import APPROVED


@dataclass(frozen=True)
class IdentityCheck:
    """Name expensive checks so ports can share host-wide work such as MQTT."""
    name: str
    run: Callable[[], dict | None]
    per_port: bool = False

    def __call__(self):
        return self.run()


class IdentificationRace:
    def __init__(self, providers, stop_event):
        self.providers = providers
        self.stop_event = stop_event
        self.pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix='printer-identify')
        self.lock = threading.Lock()
        self.jobs = {}
        self.checks = {}
        self.failed = set()
        self.results = {}

    def identify(self, host, port):
        target = (host, port)
        with self.lock:
            if host in self.results:
                return self.results[host]
            if target in self.failed:
                return None
            if target not in self.jobs:
                jobs = []
                for provider in self.providers:
                    for index, check in enumerate(provider.identifiers(host, port, self.stop_event)):
                        named = isinstance(check, IdentityCheck)
                        key = (provider.id, host, check.name if named else index,
                               port if named and check.per_port else None)
                        if key not in self.checks:
                            self.checks[key] = self.pool.submit(check)
                        jobs.append(self.checks[key])
                self.jobs[target] = jobs
            jobs = self.jobs[target]
        for job in as_completed(jobs):
            if self.stop_event.is_set():
                return None
            try:
                values = job.result()
            except Exception:
                continue
            adapter = next((provider for provider in self.providers if values and provider.id == values.get('provider')), None)
            approved = adapter and any(adapter.approved_stream(dict(values, kind=kind, port=profile['port']))
                                       for kind, profile in APPROVED.get(adapter.id, {}).items())
            if approved:
                with self.lock:
                    winner = self.results.setdefault(host, values)
                for pending in jobs:
                    if pending is not job:
                        pending.cancel()
                return winner
        with self.lock:
            # A failed TLS check on a control/alternate port says nothing about
            # the actual camera port. Positive identity remains shared by host.
            self.failed.add(target)
            return self.results.get(host)

    def close(self):
        self.pool.shutdown(wait=True, cancel_futures=True)
