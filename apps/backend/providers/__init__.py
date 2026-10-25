"""Camera adapter registry. Discovery, playback, and the UI use public capabilities."""

import hashlib
from urllib.parse import urlsplit

from .bambu import BambuProvider
from .mjpeg import MjpegProvider
from .rtsp import RtspProvider
from .policy import APPROVED, approved_ports


PROVIDERS = (BambuProvider(), RtspProvider(), MjpegProvider())
BY_ID = {provider.id: provider for provider in PROVIDERS}
PROTOCOLS = {kind: provider for provider in PROVIDERS for kind in provider.protocols}


def camera_id(host, port, kind):
    return hashlib.sha256(f'{host.lower()}:{port}:{kind}'.encode()).hexdigest()[:16]


def describe(item, source=None, connection=None, provider=None):
    item = dict(item)
    if connection:
        for adapter in PROVIDERS:
            if identify := getattr(adapter, 'identify', None):
                item.update(identify(connection))
    adapter = BY_ID.get(provider) if provider else next((value for value in PROVIDERS if value.matches(item, source)), None)
    if not adapter:
        raise ValueError('Unsupported camera protocol or adapter.')
    item.setdefault('id', camera_id(item['host'], item['port'], item['kind']))
    item.setdefault('name', item['host'])
    return dict(item, **adapter.public(item))


def endpoint(source, provider=None):
    parsed = urlsplit(source)
    transport = PROTOCOLS.get(parsed.scheme)
    if not transport or not parsed.hostname:
        raise ValueError('Unsupported camera URL.')
    port = parsed.port if parsed.port is not None else transport.protocols[parsed.scheme]
    if not 1 <= port <= 65535:
        raise ValueError('Invalid camera port.')
    return describe({'host': parsed.hostname, 'port': port,
                     'kind': parsed.scheme}, source=source, provider=provider)


def approved_camera(item):
    adapter = BY_ID.get(item.get('provider'))
    return bool(adapter and adapter.id in APPROVED and adapter.approved_stream(item))


def validate_transport_source(source):
    if not source:
        return
    if any(ord(character) < 32 or ord(character) == 127 for character in source):
        raise ValueError('Invalid camera URL.')
    item = endpoint(source)
    BY_ID[item['provider']].validate(source)


def validate_source(source):
    validate_transport_source(source)
    if source and not any(provider.id in APPROVED and provider.accepts_source(source) for provider in PROVIDERS):
        raise ValueError('The stream is not on the approved printer list.')


def discovery_ports(configured=''):
    ports = approved_ports()
    try:
        for value in configured.split(',') if configured else ():
            kind, number = value.strip().split(':')
            port = int(number)
            if ports.get(port) != kind:
                raise ValueError
            ports[port] = kind
        if len(ports) > 32:
            raise ValueError
    except ValueError:
        raise ValueError('DISCOVERY_PORTS may only contain camera ports from the approved printer list.') from None
    return ports


def probe(host, port, kind, tls):
    return PROTOCOLS[kind].probe(host, port, kind, tls, describe)


def discover_names(networks, targets, stop_event):
    result = {}
    for provider in PROVIDERS:
        for host, values in provider.discover_names(networks, targets, stop_event).items():
            result.setdefault(host, {}).update(values)
    return result
