"""Camera service discovery through RTSP responses, independent of manufacturer."""

import socket

from .base import StreamProvider


class RtspProvider(StreamProvider):
    id = 'rtsp'
    protocols = {'rtsp': 554, 'rtsps': 322}
    ports = {322: 'rtsps', 554: 'rtsp', 8554: 'rtsp'}

    def probe(self, host, port, kind, tls, describe):
        with socket.create_connection((host, port), timeout=0.45) as raw:
            raw.settimeout(4)
            connection = tls.wrap_socket(raw, server_hostname=host) if kind == 'rtsps' else raw
            with connection:
                target = f'{kind}://{host}:{port}/'
                connection.sendall(f'OPTIONS {target} RTSP/1.0\r\nCSeq: 1\r\n\r\n'.encode())
                if not connection.recv(1024).startswith(b'RTSP/1.'):
                    return None
                return describe({'host': host, 'port': port, 'kind': kind},
                                connection=connection if kind == 'rtsps' else None)
