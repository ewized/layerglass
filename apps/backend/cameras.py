"""Camera selection and saved connections, driven by camera adapters."""

from dataclasses import replace
import json
import logging
import os
from pathlib import Path
import threading
from urllib.parse import unquote, urlsplit

from discovery import Discovery, endpoint
from identity import display_name, identity
from providers import APPROVED, BY_ID, approved_camera, describe, validate_source, validate_transport_source
from providers.telemetry import public_stats, sanitized_identity


LOG = logging.getLogger('printer-camera')


class CameraRegistry:
    def __init__(self, settings, relay_factory, telemetry_factory=None):
        self.settings = settings
        self.relay_factory = relay_factory
        self.discovery = Discovery(settings.stream_url, os.environ.get('DISCOVERY_CIDRS', ''))
        self.lock = threading.RLock()
        self.sources = {}
        self.relays = {}
        self.telemetry = {}
        self.telemetry_tokens = {}
        self.telemetry_factory = telemetry_factory
        self.provider_ids = {}
        self.identities = {}
        self.quarantined = {}
        self.quarantine_unsaved = False
        self.identity_scan = object()
        self.known = {}
        self.forgotten = set()
        self.dismissed = {}
        self.store = Path(os.environ.get('CAMERA_DATA_DIR', '/data')) / 'printers.json'
        saved = {}
        try:
            saved = json.loads(self.store.read_text())
            if saved.get('version') in (2, 3):
                self.forgotten = set(saved.get('forgotten', []))
                self.identities = {key: identity(value) for key, value in saved.get('identities', {}).items()
                                   if isinstance(value, dict)}
                self.provider_ids = {key: value for key, value in saved.get('providers', {}).items() if value in BY_ID}
                self._load_quarantined(saved.get('quarantined', {}))
                saved = saved['sources']
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError, AttributeError, KeyError):
            saved = {}
            LOG.warning('Could not load saved printer settings.')
        if settings.stream_url:
            key = endpoint(settings.stream_url)['id']
            if key not in self.forgotten and key not in self.quarantined:
                self.sources[key] = settings.stream_url
        for source in saved.values():
            try:
                # Keep old settings privately so a policy change never erases
                # credentials. Only approved profiles are exposed or started.
                validate_transport_source(source)
                key = endpoint(source)['id']
                if key not in self.quarantined:
                    self.sources[key] = source
            except (ValueError, TypeError, AttributeError):
                LOG.warning('Could not load saved printer settings.')
        self.default_id = next((key for key in self.sources if self._source_camera(key)), None)

    def _load_quarantined(self, values):
        for record in values.values() if isinstance(values, dict) else ():
            try:
                source = record['source']
                validate_transport_source(source)
                metadata = identity(record['identity'])
                if metadata.get('serial'):
                    self.quarantined[endpoint(source)['id']] = {
                        'source': source, 'identity': metadata,
                        'provider': record.get('provider') if record.get('provider') in BY_ID else None}
            except (ValueError, TypeError, AttributeError, KeyError):
                LOG.warning('Could not load quarantined printer settings.')

    def _source_camera(self, key):
        source = self.sources.get(key)
        if not source or key in self.quarantined:
            return None
        try:
            validate_source(source)
            provider = self.provider_ids.get(key)
            item = describe(dict(endpoint(source), **self.identities.get(key, {})),
                            provider=provider if provider in APPROVED else None)
            return item if approved_camera(item) else None
        except ValueError:
            return None

    def start(self):
        self.discovery.prioritize(endpoint(source)['host'] for source in self.sources.values())
        if self.default_id:
            self.get_relay(self.default_id)
        self.discovery.start()

    def close(self):
        self.discovery.close()
        with self.lock:
            relays = list(self.relays.values())
            telemetry = list(self.telemetry.values())
            self.telemetry_tokens.clear()
        for relay in relays:
            relay.close()
        for client in telemetry:
            client.close()

    def catalog(self):
        retired = []
        try:
            return self._catalog(retired)
        finally:
            # A telemetry close may join a callback that needs registry.lock.
            # All callers enter catalog before acquiring that lock themselves.
            for client in retired:
                client.close()

    def _catalog(self, retired):
        with self.lock:
            # Snapshot selection shares the pairing mutation order. A queued
            # reader must not apply an older identity after replacement setup.
            discovery = self.discovery.status()
            update_identity = self.identity_scan != discovery['finished_at']
            if self.quarantine_unsaved and update_identity:
                try:
                    self._save(self.sources, self.forgotten)
                except OSError:
                    LOG.warning('Could not save printer replacement quarantine.')
            cameras = {key: dict(item, configured=key in self.sources, discovered=False)
                       for key, item in self.known.items()}
            cameras.update({key: dict(self._source_camera(key) or endpoint(source), configured=True, discovered=False)
                            for key, source in self.sources.items()})
            cameras.update({key: dict(endpoint(record['source'], provider=record.get('provider')),
                                      configured=False, discovered=False)
                            for key, record in self.quarantined.items() if key not in cameras})
            # Only approved manufacturer profiles enter the printer catalog.
            by_host = set()
            for item in sorted((item for item in discovery.pop('found') if approved_camera(item)), key=lambda item: (item['id'] not in self.sources,
                               list(BY_ID).index(item['provider']), item['kind'] != 'rtsps')):
                if item['id'] in self.dismissed and self.dismissed[item['id']] == discovery['finished_at']:
                    continue  # Cached results must not immediately restore a forgotten printer.
                adapter = BY_ID[item['provider']]
                if adapter.deduplicate_host and item['host'] in by_host:
                    continue
                cameras[item['id']] = dict(item, configured=item['id'] in self.sources, discovered=True)
                new_identity = item['id'] not in self.known
                self.known[item['id']] = dict(item)
                # Announcements describe a physical printer, including when its
                # saved camera endpoint uses another port/protocol.
                metadata = identity({key: value for key, value in item.items() if key != 'name' or value != item['host']})
                if metadata:
                    for key, camera in cameras.items():
                        if camera['host'] == item['host']:
                            replaced = self._quarantine_replacement(key, metadata, retired)
                            if not replaced and (update_identity or new_identity):
                                self._remember_identity(key, metadata)
                if adapter.deduplicate_host:
                    by_host.add(item['host'])
            self.identity_scan = discovery['finished_at']
            cameras = {key: camera for key, camera in cameras.items()
                       if approved_camera(dict(camera, **self.identities.get(key, {})))}
            for key, camera in cameras.items():
                camera.update(self.identities.get(key, {}))
                camera.update(BY_ID[camera['provider']].public(camera))
                camera['configured'] = bool(self._source_camera(key))
                camera['name'] = display_name(self.identities.get(key, {}), camera['host'], key)
                # Approval/model mapping use the private identity above. Only
                # its public projection may redact a code inside a serial/model.
                for field in ('name', 'firmware', 'serial', 'model', 'model_name'):
                    if field in camera:
                        camera[field] = public_stats(camera[field], secrets=self._secrets(key))
            preferred = self.default_id if self.default_id in cameras else next(
                (key for key in self.sources if key in cameras and cameras[key]['configured']), None)
            self.default_id = preferred
            values = sorted(cameras.values(), key=lambda item: (item['id'] != preferred, item['host']))
            return {'cameras': values, 'discovery': discovery,
                    'default_camera_id': preferred or (values[0]['id'] if values else None)}

    def _candidate(self, key):
        source = self.sources.get(key) or self.quarantined.get(key, {}).get('source')
        item = self.known.get(key) or (endpoint(source, provider=self.provider_ids.get(key)) if source else None)
        if not item:
            return None
        item = describe(dict(item, **self.identities.get(key, {})), provider=item['provider'])
        return item if approved_camera(item) else None

    def _retire(self, key):
        self.telemetry_tokens.pop(key, None)
        return [client for client in (self.telemetry.pop(key, None), self.relays.pop(key, None)) if client]

    def _quarantine_replacement(self, key, metadata, retired):
        source = self.sources.get(key)
        paired = self.identities.get(key, {})
        if not source or not paired.get('serial') or not metadata.get('serial') or paired['serial'] == metadata['serial']:
            return False
        sources = {item: value for item, value in self.sources.items() if item != key}
        quarantined = dict(self.quarantined, **{key: {
            'source': source, 'identity': dict(paired), 'provider': self.provider_ids.get(key, endpoint(source)['provider'])}})
        identities = dict(self.identities, **{key: sanitized_identity(metadata, secrets=self._secrets(key))})
        try:
            self._save(sources, self.forgotten, identities, quarantined=quarantined)
        except OSError:
            # Keep the old on-disk binding atomic, but never authenticate with it
            # in this process after observing a different verified printer.
            self.quarantine_unsaved = True
            LOG.warning('Could not save printer replacement quarantine.')
        self.sources, self.identities, self.quarantined = sources, identities, quarantined
        retired.extend(self._retire(key))
        return True

    def get_relay(self, key):
        self.catalog()
        with self.lock:
            source = self.sources.get(key)
            if not source or not self._source_camera(key):
                return None
            if key not in self.relays:
                settings = replace(self.settings, stream_url=source,
                                   stream_root=self.settings.stream_root / key)
                adapter = BY_ID[endpoint(source, provider=self.provider_ids.get(key))['provider']]
                relay = adapter.create_relay(settings, self.relay_factory)
                relay.start()
                self.relays[key] = relay
            self._get_telemetry(key)
            return self.relays[key]

    def get_telemetry(self, key):
        self.catalog()
        return self._get_telemetry(key)

    def _get_telemetry(self, key):
        with self.lock:
            source = self.sources.get(key)
            if not source or not self._source_camera(key):
                return None
            adapter = BY_ID[endpoint(source, provider=self.provider_ids.get(key))['provider']]
            if not adapter.telemetry_supported:
                return None
            if key not in self.telemetry:
                token = self.telemetry_tokens[key] = object()
                on_identity = lambda values: self._remember_identity(key, values, source, token)
                client = (self.telemetry_factory(source, saved=self.identities.get(key), on_identity=on_identity)
                          if self.telemetry_factory else adapter.create_telemetry(source, self.identities.get(key), on_identity))
                self.telemetry[key] = client
                client.start()
            return self.telemetry[key]

    def _remember_identity(self, key, values, source=None, token=None):
        with self.lock:
            if source is not None and self.sources.get(key) != source:
                return
            if token is not None and self.telemetry_tokens.get(key) is not token:
                return
            serial = self.identities.get(key, {}).get('serial')
            if source is not None and serial and identity(values).get('serial', serial) != serial:
                return
            updated = sanitized_identity(dict(self.identities.get(key, {}), **values), secrets=self._secrets(key))
            if updated == self.identities.get(key, {}):
                return
            self.identities[key] = updated
            try:
                self._save(self.sources, self.forgotten)
            except OSError:
                LOG.warning('Could not save printer identity.')

    def _secrets(self, key):
        return tuple(unquote(urlsplit(source).password or '') for source in
                     (self.sources.get(key, ''), self.quarantined.get(key, {}).get('source', '')))

    def _quarantined_at(self, host):
        return {key for key, record in self.quarantined.items() if endpoint(record['source'])['host'] == host}

    def status(self, key=None):
        if not key:
            key = self.catalog()['default_camera_id']
        relay = self.get_relay(key)
        if not relay:
            item = next((item for item in self.catalog()['cameras'] if item['id'] == key), None)
            return {'state': 'setup' if item else 'empty', 'camera_id': key,
                    'message': ('Enter this printer’s LAN access code.' if item.get('setup', {}).get('type') == 'access_code'
                                else 'Configure this camera connection.') if item else 'No printer streams found.',
                    'generation': None, 'playlist_url': None, 'jpeg_url': None}
        status = relay.status()
        telemetry = self.get_telemetry(key)
        status['printer'] = telemetry.status() if telemetry else None
        status['camera_id'] = key
        status['jpeg_url'] = f'/api/cameras/{key}/frame.jpg' if hasattr(relay, 'frame') else None
        if status['playlist_url']:
            status['playlist_url'] = status['playlist_url'].replace('/stream/', f'/stream/{key}/', 1)
        return status

    def configure(self, key, code=None, **connection):
        self.catalog()
        with self.lock:
            item = self._candidate(key)
            if not item:
                raise ValueError('Printer is no longer available. Scan the network again.')
            previous = self.sources.get(key)
            adapter = BY_ID[item['provider']]
            source = adapter.configure(item, dict(connection, access_code=code), previous)
            updated = dict(self.sources, **{key: source})
            cleared = self._quarantined_at(item['host'])
            forgotten = (self.forgotten | cleared) - {key}
            quarantined = {item: value for item, value in self.quarantined.items() if item not in cleared}
            identities = {item: value for item, value in self.identities.items() if item not in cleared or item == key}
            provider_ids = {item: value for item, value in self.provider_ids.items() if item not in cleared}
            provider_ids[key] = adapter.id
            self._save(updated, forgotten, identities, provider_ids, quarantined)
            retired = [client for item in cleared | {key} for client in self._retire(item)]
            self.sources = updated
            self.forgotten = forgotten
            self.provider_ids = provider_ids
            self.identities = identities
            self.quarantined = quarantined
            for item in cleared - {key}:
                self.known.pop(item, None)
                self.dismissed[item] = self.discovery.status()['finished_at']
        for client in retired:
            client.close()
        self.get_relay(key)

    def _save(self, sources, forgotten, identities=None, providers=None, quarantined=None):
        self.store.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.store.with_suffix('.tmp')
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as file:
            os.fchmod(file.fileno(), 0o600)
            json.dump({'version': 3, 'sources': sources, 'forgotten': sorted(forgotten),
                       'identities': self.identities if identities is None else identities,
                       'providers': self.provider_ids if providers is None else providers,
                       'quarantined': self.quarantined if quarantined is None else quarantined}, file)
        temporary.replace(self.store)
        self.quarantine_unsaved = False

    def forget(self, key):
        self.catalog()
        with self.lock:
            item = self._candidate(key)
            if not item and key not in self.quarantined:
                raise ValueError('Printer is no longer available.')
            host = item['host'] if item else endpoint(self.quarantined[key]['source'])['host']
            cleared = self._quarantined_at(host) | {key}
            updated = {item: source for item, source in self.sources.items() if item not in cleared}
            forgotten = self.forgotten | cleared
            identities = {item: value for item, value in self.identities.items() if item not in cleared}
            provider_ids = {item: value for item, value in self.provider_ids.items() if item not in cleared}
            quarantined = {item: value for item, value in self.quarantined.items() if item not in cleared}
            self._save(updated, forgotten, identities, provider_ids, quarantined)
            self.sources = updated
            self.forgotten = forgotten
            self.identities = identities
            self.provider_ids = provider_ids
            self.quarantined = quarantined
            for item in cleared:
                self.known.pop(item, None)
                self.dismissed[item] = self.discovery.status()['finished_at']
            if self.default_id == key:
                self.default_id = next((key for key in updated if self._source_camera(key)), None)
            retired = [client for item in cleared for client in self._retire(item)]
        for client in retired:
            client.close()

    def healthy(self):
        with self.lock:
            return all(relay.thread.is_alive() for relay in self.relays.values())
