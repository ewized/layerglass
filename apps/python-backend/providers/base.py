"""Shared connection validation; camera addresses always come from discovery."""

from urllib.parse import quote, urlsplit, urlunsplit


def credentials(item, values, default_path='/'):
    username = values.get('username', '')
    password = values.get('password', '')
    path = values.get('path', default_path)
    for value, limit in ((username, 128), (password, 256), (path, 1024)):
        if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError('Invalid camera connection settings.')
    parsed = urlsplit(path)
    if not path.startswith('/') or path.startswith('//') or parsed.scheme or parsed.netloc or parsed.fragment:
        raise ValueError('Enter a stream path beginning with / on the discovered camera.')
    if password and not username:
        raise ValueError('Enter a username when supplying a password.')
    auth = f'{quote(username, safe="")}:{quote(password, safe="")}@' if username else ''
    return urlunsplit((item['kind'], f'{auth}{item["host"]}:{item["port"]}',
                       quote(parsed.path, safe='/%:@!$&\'()*+,;=-._~'), parsed.query, ''))


class StreamProvider:
    """Adapter contract. New adapters register themselves in providers/__init__.py."""

    protocols = {}
    ports = {}
    deduplicate_host = False
    manufacturer = None
    telemetry_supported = False

    def approved_stream(self, item):
        return False

    def accepts_source(self, source):
        return False

    def identifiers(self, host, port, stop_event):
        return ()

    def matches(self, item, source=None):
        return item['kind'] in self.protocols

    def public(self, item):
        return {'provider': self.id, 'manufacturer': self.manufacturer,
                'setup': {'type': 'connection', 'path': item.get('path', '/')}}

    def configure(self, item, values, previous=None):
        return credentials(item, values, item.get('path', '/'))

    def validate(self, source):
        pass

    def create_relay(self, settings, relay_factory):
        return relay_factory(settings)

    def create_telemetry(self, source, saved, on_identity):
        return None

    def discover_names(self, networks, targets, stop_event):
        return {}
