"""Authenticated native JPEG camera relay."""

import logging
import socket
import ssl
import struct
import threading
import time
from urllib.parse import unquote, urlsplit
import uuid

LOG = logging.getLogger("printer-camera")


class JpegRelay:
    """One authenticated connection, shared by every browser viewing a P1/A1."""

    def __init__(self, settings):
        self.settings = settings
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.restart_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name='jpeg-relay', daemon=True)
        self.connection = None
        self.frame = None
        self.generation = None
        self.state = 'connecting'
        self.last_segment_at = None
        self.restarts = 0
        self.created_at = time.monotonic()

    def start(self):
        self.thread.start()

    def _interrupt(self):
        with self.lock:
            connection = self.connection
        if connection:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def close(self):
        self.stop_event.set()
        self.restart_event.set()
        self._interrupt()
        self.thread.join(timeout=8)

    def request_restart(self):
        pending = self.restart_event.is_set()
        self.restart_event.set()
        self._interrupt()
        return not pending

    def status(self):
        with self.lock:
            age = time.time() - self.last_segment_at if self.last_segment_at else None
            return {'state': self.state, 'generation': self.generation, 'playlist_url': None,
                    'message': 'Camera connected.' if self.state == 'live' else 'Reconnecting to the camera… Check its access code if this continues.',
                    'last_segment_age_seconds': round(age, 1) if age is not None else None,
                    'restarts': self.restarts, 'uptime_seconds': int(time.monotonic() - self.created_at)}

    @staticmethod
    def _read(connection, length):
        data = bytearray()
        while len(data) < length:
            chunk = connection.recv(length - len(data))
            if not chunk:
                raise OSError('Camera disconnected.')
            data.extend(chunk)
        return bytes(data)

    def _run(self):
        parsed = urlsplit(self.settings.stream_url)
        username = unquote(parsed.username or 'bblp').encode('ascii')
        password = unquote(parsed.password or '').encode('ascii')
        auth = struct.pack('<IIII32s32s', 64, 0x3000, 0, 0, username, password)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        tls.check_hostname = False
        tls.verify_mode = ssl.CERT_NONE
        delay = self.settings.reconnect_delay
        try:
            while not self.stop_event.is_set():
                with self.lock:
                    self.restart_event.clear()
                    self.generation = uuid.uuid4().hex
                    self.state = 'connecting' if not self.restarts else 'reconnecting'
                    self.frame = None
                    self.last_segment_at = None
                try:
                    with socket.create_connection((parsed.hostname, parsed.port or 6000), timeout=4) as raw:
                        raw.settimeout(4)
                        with tls.wrap_socket(raw, server_hostname=parsed.hostname) as connection:
                            connection.settimeout(8)
                            with self.lock:
                                self.connection = connection
                            connection.sendall(auth)
                            while not self.stop_event.is_set() and not self.restart_event.is_set():
                                length = struct.unpack('<I', self._read(connection, 16)[:4])[0]
                                if not 4 <= length <= 4 * 1024 * 1024:
                                    raise OSError('Invalid camera frame.')
                                frame = self._read(connection, length)
                                if not (frame.startswith(b'\xff\xd8') and frame.endswith(b'\xff\xd9')):
                                    raise OSError('Invalid camera frame.')
                                with self.lock:
                                    self.frame = frame
                                    self.last_segment_at = time.time()
                                    self.state = 'live'
                                delay = self.settings.reconnect_delay
                except (OSError, ssl.SSLError):
                    if not self.stop_event.is_set():
                        LOG.warning('JPEG camera disconnected; retrying automatically.')
                finally:
                    with self.lock:
                        self.connection = None
                        self.state = 'reconnecting'
                        self.restarts += 1
                if not self.stop_event.is_set():
                    self.restart_event.wait(delay)
                    delay = min(delay * 2, 30)
        finally:
            with self.lock:
                self.state = 'stopped'
