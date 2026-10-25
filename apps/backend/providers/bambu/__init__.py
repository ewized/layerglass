"""Bambu-specific camera authentication, discovery identity, and local telemetry."""

import socket
from urllib.parse import quote, unquote, urlsplit

from ..base import StreamProvider
from .announcements import discover_names
from .jpeg import JpegRelay
from .telemetry import PrinterTelemetry, camera_protocol, certificate_identity, model_name
from .identification import identifiers
from ..policy import APPROVED


class BambuProvider(StreamProvider):
    id = 'bambu'
    manufacturer = 'Bambu Lab'
    protocols = {'bambu': 6000}
    ports = {6000: 'bambu'}
    deduplicate_host = True
    telemetry_supported = True

    def identifiers(self, host, port, stop_event):
        return identifiers(host, port, stop_event)

    def approved_stream(self, item):
        kind = camera_protocol(item)
        profile = APPROVED.get(self.id, {}).get(kind)
        return bool(profile and item['kind'] == kind and item['port'] == profile['port'])

    def accepts_source(self, source):
        parsed = urlsplit(source)
        profile = APPROVED.get(self.id, {}).get(parsed.scheme)
        return bool(profile and (parsed.port or self.protocols.get(parsed.scheme, 322)) == profile['port'] and
                    parsed.username in (None, 'bblp') and not parsed.query and not parsed.fragment and
                    (parsed.path == profile['path'] or parsed.scheme == 'bambu'))

    def matches(self, item, source=None):
        return (item.get('provider') == self.id or item['kind'] == 'bambu' or bool(model_name(item.get('model'), item.get('serial'))) or
                bool(source and item['kind'] in ('rtsp', 'rtsps') and urlsplit(source).username == 'bblp'))

    def identify(self, connection):
        return certificate_identity(connection) if connection else {}

    def public(self, item):
        return {'provider': self.id, 'manufacturer': self.manufacturer,
                'model_name': model_name(item.get('model'), item.get('serial')), 'setup': {'type': 'access_code'}}

    def probe(self, host, port, kind, tls, describe):
        with socket.create_connection((host, port), timeout=0.45) as raw:
            raw.settimeout(4)
            with tls.wrap_socket(raw, server_hostname=host) as connection:
                metadata = self.identify(connection)
                return describe({'host': host, 'port': port, 'kind': kind, **metadata})

    def configure(self, item, values, previous=None):
        if not self.approved_stream(item) or set(values) - {'access_code'}:
            raise ValueError('Choose an approved printer stream and enter its LAN access code.')
        code = values.get('access_code')
        if not isinstance(code, str) or not 1 <= len(code) <= 32 or not code.isascii() or any(ord(c) < 32 for c in code):
            raise ValueError('Enter a LAN access code of 1–32 ASCII characters.')
        profile = APPROVED[self.id][item['kind']]
        return f'{item["kind"]}://bblp:{quote(code, safe="")}@{item["host"]}:{item["port"]}{profile["path"]}'

    def validate(self, source):
        parsed = urlsplit(source)
        if parsed.scheme in ('bambu', 'rtsps'):
            code, user = unquote(parsed.password or ''), unquote(parsed.username or 'bblp')
            if not code.isascii() or not user.isascii() or not 1 <= len(code) <= 32 or len(user) > 32:
                raise ValueError('Printer camera credentials must be ASCII, up to 32 characters.')

    def create_relay(self, settings, relay_factory):
        return JpegRelay(settings) if urlsplit(settings.stream_url).scheme == 'bambu' else relay_factory(settings)

    def create_telemetry(self, source, saved, on_identity):
        return PrinterTelemetry(source, saved=saved, on_identity=on_identity)

    def discover_names(self, networks, targets, stop_event):
        return discover_names(networks, targets, stop_event)
