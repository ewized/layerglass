"""Discover actual HTTP MJPEG feeds; an open web port is not a camera."""

from dataclasses import replace
import http.client

from .base import StreamProvider


class MjpegProvider(StreamProvider):
    id = 'mjpeg'
    protocols = {'http': 80, 'https': 443}
    ports = {80: 'http', 443: 'https', 8080: 'http', 8081: 'http'}
    paths = ('/?action=stream', '/stream', '/webcam/?action=stream', '/webcam/stream', '/video')

    def probe(self, host, port, kind, tls, describe):
        # Stop after the first verified camera on each host/port. No redirects,
        # credential attempts, application APIs, or whole-stream downloads.
        for path in self.paths:
            connection = (http.client.HTTPSConnection(host, port, timeout=0.8, context=tls) if kind == 'https'
                          else http.client.HTTPConnection(host, port, timeout=0.8))
            try:
                connection.request('GET', path, headers={'Accept': 'multipart/x-mixed-replace', 'Connection': 'close'})
                response = connection.getresponse()
                if response.status != 200 or response.getheader('Content-Type', '').split(';')[0].strip().lower() != 'multipart/x-mixed-replace':
                    continue
                prefix = response.read1(4096)
                if b'\xff\xd8' in prefix or b'content-type: image/jpeg' in prefix.lower():
                    return describe({'host': host, 'port': port, 'kind': kind, 'path': path})
            except (OSError, http.client.HTTPException):
                # A refused connection has no HTTP paths to try.
                if connection.sock is None:
                    return None
            finally:
                connection.close()
        return None

    def create_relay(self, settings, relay_factory):
        # MJPEG cannot be copied directly into the browser's HLS/MSE pipeline.
        return relay_factory(replace(settings, stream_mode='transcode'))
