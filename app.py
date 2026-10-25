"""LAN-only printer camera viewer with local network discovery.

Only the server sees camera connection credentials.
"""

from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import logging
import math
import mimetypes
import os
from pathlib import Path
import re
import shutil
import signal
import struct
import subprocess
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit
import uuid

from providers import validate_source

LOG = logging.getLogger('printer-camera')
STATIC = Path(__file__).parent / 'static'


def app_shell_revision():
    """Change the worker whenever shipped UI assets change, without a build step."""
    digest = hashlib.sha256()
    for file in sorted(STATIC.rglob('*')):
        if file.is_file() and file.suffix != '.map':
            digest.update(file.relative_to(STATIC).as_posix().encode() + b'\0')
            digest.update(file.read_bytes())
    return digest.hexdigest()[:24]


APP_SHELL_REVISION = app_shell_revision()
PWA_CACHE_ENABLED = os.environ.get('PWA_CACHE_ENABLED', '0') == '1'


def configured_origins(value):
    """Exact, credential-free origins; no wildcard or arbitrary CSP tokens."""
    origins = set()
    for origin in value.split(',') if isinstance(value, str) else value:
        if not isinstance(origin, str):
            raise ValueError('Viewer origins must be strings.')
        origin = origin.strip().rstrip('/')
        if not origin:
            continue
        parsed = urlsplit(origin)
        if (not re.fullmatch(r'https?://(?:[A-Za-z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?', origin) or
                parsed.scheme not in ('http', 'https') or not parsed.hostname or
                parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or
                any(character.isspace() for character in origin) or '*' in origin):
            raise ValueError('Viewer origins must be exact HTTP(S) origins without paths, wildcards or credentials.')
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError('Viewer origin port is invalid.')
        origins.add(origin)
    return frozenset(origins)


@dataclass(frozen=True)
class Settings:
    stream_url: str
    stream_mode: str = 'copy'
    stale_timeout: float = 30
    reconnect_delay: float = 3
    transcode_fps: int = 15
    port: int = 8080
    stream_root: Path = Path('/tmp/camera-hls')

    @classmethod
    def from_env(cls):
        source = os.environ.get('STREAM_URL', '').strip()
        try:
            parsed = urlsplit(source)
            validate_source(source)
            valid = True
        except ValueError:
            valid = False
        if not valid or any(ord(c) < 32 for c in source):
            raise ValueError('STREAM_URL must be empty or a complete stream URL from the approved printer list.')
        mode = os.environ.get('STREAM_MODE', 'copy').lower()
        if mode not in ('copy', 'transcode'):
            raise ValueError('STREAM_MODE must be copy or transcode.')
        try:
            stale = float(os.environ.get('STALE_TIMEOUT_SECONDS', '30'))
            retry = float(os.environ.get('RECONNECT_DELAY_SECONDS', '3'))
            fps = int(os.environ.get('TRANSCODE_FPS', '15'))
            port = int(os.environ.get('PORT', '8080'))
        except ValueError:
            raise ValueError('Timeout, frame rate and port settings must be numeric.') from None
        if not math.isfinite(stale) or not 10 <= stale <= 600:
            raise ValueError('STALE_TIMEOUT_SECONDS must be between 10 and 600.')
        if not math.isfinite(retry) or not 1 <= retry <= 30:
            raise ValueError('RECONNECT_DELAY_SECONDS must be between 1 and 30.')
        if not 1 <= fps <= 60 or not 1 <= port <= 65535:
            raise ValueError('Frame rate must be 1–60 and port must be 1–65535.')
        return cls(stream_url=source, stream_mode=mode, stale_timeout=stale,
                   reconnect_delay=retry, transcode_fps=fps, port=port)


def safe_error(text, source):
    """FFmpeg can echo an input URL: redact it before saving or logging."""
    text = text.replace(source, '[camera URL]')
    parsed = urlsplit(source)
    for secret in (parsed.username, parsed.password):
        if secret:
            text = text.replace(secret, '[redacted]').replace(unquote(secret), '[redacted]')
    return re.sub(r'(?:rtsps?|https?)://[^\s]+', '[camera URL]', text).strip()[:600]


def ffmpeg_command(settings, directory):
    transport = (['-rtsp_transport', 'tcp', '-timeout', '10000000'] if urlsplit(settings.stream_url).scheme in ('rtsp', 'rtsps')
                 else ['-rw_timeout', '10000000'])
    command = [
        'ffmpeg', '-hide_banner', '-nostdin', '-loglevel', 'warning', *transport,
        '-fflags', '+genpts', '-i', settings.stream_url,
        '-map', '0:v:0', '-an', '-sn', '-dn',
    ]
    if settings.stream_mode == 'copy':
        command += ['-c:v', 'copy']
    else:
        fps = settings.transcode_fps
        command += [
            '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p', '-r', str(fps), '-g', str(fps * 2),
            '-keyint_min', str(fps * 2), '-sc_threshold', '0', '-crf', '23',
            '-threads', '2',
        ]
    command += [
        '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6',
        '-hls_delete_threshold', '2', '-hls_start_number_source', 'epoch',
        '-hls_flags', 'delete_segments+omit_endlist+temp_file+program_date_time',
        '-hls_segment_filename', str(directory / 'segment-%010d.ts'),
        str(directory / 'live.m3u8'),
    ]
    return command


class Relay:
    def __init__(self, settings):
        self.settings = settings
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.restart_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name='camera-relay', daemon=True)
        self.state = 'connecting'
        self.generation = None
        self.directory = None
        self.restarts = 0
        self.last_error = None
        self.last_segment_at = None
        self.created_at = time.monotonic()
        self._restart_pending = False

    def start(self):
        self.settings.stream_root.mkdir(parents=True, exist_ok=True)
        self.thread.start()

    def close(self):
        self.stop_event.set()
        self.restart_event.set()
        if self.thread.is_alive():
            self.thread.join(timeout=8)

    def request_restart(self):
        with self.lock:
            already_pending = self._restart_pending
            self._restart_pending = True
            self.state = 'reconnecting'
            self.restart_event.set()
        return not already_pending

    def status(self):
        with self.lock:
            age = None if self.last_segment_at is None else max(0, time.time() - self.last_segment_at)
            messages = {
                'connecting': 'Connecting to the camera…',
                'live': 'Camera connected.',
                'reconnecting': 'Reconnecting to the camera automatically…',
                'stopped': 'Camera relay is stopped.',
            }
            return {
                'state': self.state,
                'message': messages[self.state],
                'generation': self.generation,
                'playlist_url': f'/stream/{self.generation}/live.m3u8' if self.generation else None,
                'last_segment_age_seconds': round(age, 1) if age is not None else None,
                'restarts': self.restarts,
                'uptime_seconds': int(time.monotonic() - self.created_at),
            }

    def _stderr(self, pipe):
        try:
            for line in pipe:
                clean = safe_error(line, self.settings.stream_url)
                if clean:
                    with self.lock:
                        self.last_error = clean
                    LOG.warning('Camera: %s', clean)
        finally:
            pipe.close()

    @staticmethod
    def _terminate(process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

    def _run(self):
        process = None
        reader = None
        retry_delay = self.settings.reconnect_delay
        previous_directory = None
        try:
            while not self.stop_event.is_set():
                # Clear a consumed manual restart while holding the same lock
                # used by HTTP requests, so a newer request cannot be lost.
                with self.lock:
                    self.restart_event.clear()
                    self._restart_pending = False
                    self.generation = uuid.uuid4().hex
                    self.directory = self.settings.stream_root / self.generation
                    self.last_segment_at = None
                    self.state = 'connecting' if self.restarts == 0 else 'reconnecting'
                    directory = self.directory
                if previous_directory:
                    shutil.rmtree(previous_directory, ignore_errors=True)
                directory.mkdir()
                previous_directory = directory
                LOG.info('Connecting camera relay (attempt %s).', self.restarts + 1)
                process = subprocess.Popen(
                    ffmpeg_command(self.settings, directory),
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                    text=True, encoding='utf-8', errors='replace',
                )
                reader = threading.Thread(target=self._stderr, args=(process.stderr,), daemon=True)
                reader.start()
                started = time.monotonic()
                last_progress = started
                last_mtime = 0
                live_since = None
                while not self.stop_event.is_set() and not self.restart_event.is_set():
                    if process.poll() is not None:
                        LOG.warning('Camera connection ended; retrying automatically.')
                        break
                    try:
                        playlist = directory / 'live.m3u8'
                        mtime = playlist.stat().st_mtime
                        if mtime > last_mtime:
                            last_mtime = mtime
                            last_progress = time.monotonic()
                            if live_since is None:
                                live_since = last_progress
                            with self.lock:
                                self.last_segment_at = mtime
                                self.state = 'live'
                            if last_progress - live_since >= 15:
                                retry_delay = self.settings.reconnect_delay
                    except FileNotFoundError:
                        pass
                    if time.monotonic() - last_progress > self.settings.stale_timeout:
                        LOG.warning('Camera stopped delivering video; restarting the connection.')
                        break
                    self.restart_event.wait(0.5)
                self._terminate(process)
                process = None
                reader.join(timeout=1)
                reader = None
                if self.stop_event.is_set():
                    break
                with self.lock:
                    self.state = 'reconnecting'
                    self.restarts += 1
                    manual = self.restart_event.is_set()
                if manual:
                    retry_delay = self.settings.reconnect_delay
                else:
                    LOG.info('Next camera connection in %.0f seconds.', retry_delay)
                    self.restart_event.wait(retry_delay)
                    retry_delay = min(retry_delay * 2, 30)
        except Exception:
            # An unexpected supervisor failure should restart the container,
            # rather than leave a working web page with no recovery worker.
            LOG.exception('Camera supervisor stopped unexpectedly.')
            os._exit(1)
        finally:
            if process is not None:
                self._terminate(process)
            if reader is not None:
                reader.join(timeout=1)
            with self.lock:
                self.state = 'stopped'


class ViewerServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, relay=None, registry=None, replay=None, allowed_origins=None, backend_origins=None):
        self.relay = relay
        self.registry = registry
        self.replay = replay
        self.close_event = threading.Event()
        self.allowed_origins = configured_origins(os.environ.get('VIEWER_ALLOWED_ORIGINS', '') if allowed_origins is None else allowed_origins)
        self.backend_origins = configured_origins(os.environ.get('VIEWER_BACKEND_ORIGINS', '') if backend_origins is None else backend_origins)
        super().__init__(address, ViewerHandler)

    def server_close(self):
        self.close_event.set()
        super().server_close()

    def snapshot(self, camera=None, session=None, telemetry_after=None):
        # catalog() reads saved discovery results; it never initiates a scan.
        catalog = self.registry.catalog() if self.registry else None
        status = self.registry.status(camera) if self.registry else self.relay.status()
        replay = self.replay.status(session) if self.replay and session else None
        if replay and replay['camera_id'] != status.get('camera_id'):
            replay = None
        payload = {'version': 1, 'catalog': catalog, 'status': status,
                   'session_id': session, 'replay': replay}
        if replay and hasattr(self.replay, 'printer_updates'):
            payload['telemetry'] = self.replay.printer_updates(session, telemetry_after)
        return payload


class ViewerHandler(BaseHTTPRequestHandler):
    server_version = 'Layerglass'
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, *_args):
        pass  # Avoid logging arbitrary request paths or request bodies.

    def _cast_media_path(self):
        return re.fullmatch(
            r'/(?:replay/[a-f0-9]{32}|stream/(?:[a-f0-9]{16}/)?[a-f0-9]{32})/'
            r'(?:live\.m3u8|segment-[0-9]+\.ts)', urlsplit(self.path).path) is not None

    def do_OPTIONS(self):
        if self._cors_origin():
            method = self.headers.get('Access-Control-Request-Method')
            headers = {header.strip().lower() for header in self.headers.get('Access-Control-Request-Headers', '').split(',') if header.strip()}
            if method in ('GET', 'HEAD', 'POST') and headers <= {'content-type', 'x-viewer-request', 'range'}:
                return self._headers(204, 'text/plain', 0)
            return self._json(405, {'error': 'Method not allowed.'})
        if self._cast_media_path() and self.headers.get('Access-Control-Request-Method') in ('GET', 'HEAD'):
            return self._headers(204, 'text/plain', 0)
        return self._json(405, {'error': 'Method not allowed.'})

    def _cors_origin(self):
        origin = self.headers.get('Origin')
        path = urlsplit(self.path).path
        viewer_path = path.startswith('/api/') or re.match(r'/replay/[a-f0-9]{32}/', path)
        return origin if viewer_path and origin in self.server.allowed_origins else None

    def _origin_allowed(self):
        origin = self.headers.get('Origin')
        if not origin:
            return True
        return origin in (f'http://{self.headers.get("Host")}', f'https://{self.headers.get("Host")}') or bool(self._cors_origin())

    def _headers(self, code, content_type, length, stream=False, shell=False):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        if length is not None:
            self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'no-store, no-transform' if stream else 'no-store')
        if shell:
            self.send_header('X-App-Shell-Revision', APP_SHELL_REVISION)
        if stream or self.close_connection:
            self.send_header('Connection', 'close')
            self.close_connection = True
        if stream:
            # A close-delimited streaming response needs no chunking dependency.
            # Short API/media responses retain HTTP/1.1 connection reuse.
            self.send_header('X-Accel-Buffering', 'no')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        # A Cast receiver fetches public HLS media from its own origin. Keep
        # cross-origin access limited to playlists/segments, never APIs, codes,
        # telemetry, preview images or the continuous browser transport.
        if self._cors_origin():
            self.send_header('Access-Control-Allow-Origin', self._cors_origin())
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Expose-Headers', 'Content-Length')
            if self.command == 'OPTIONS':
                self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Viewer-Request, Range')
                self.send_header('Access-Control-Max-Age', '300')
                if self.headers.get('Access-Control-Request-Private-Network') == 'true':
                    self.send_header('Access-Control-Allow-Private-Network', 'true')
        elif self.command in ('GET', 'HEAD', 'OPTIONS') and self._cast_media_path():
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Expose-Headers', 'Content-Length')
            if self.command == 'OPTIONS':
                self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Range, Content-Type')
                if self.headers.get('Access-Control-Request-Private-Network') == 'true':
                    self.send_header('Access-Control-Allow-Private-Network', 'true')
        targets = ''.join(' ' + origin for origin in sorted(self.server.backend_origins))
        self.send_header('Content-Security-Policy',
                         "default-src 'self'; script-src 'self' https://www.gstatic.com "
                         "chrome-extension://pkedcjkdefgpdelpbcmbmeomcjbeemfm "
                         "chrome-extension://enhhojjnijigcajfphajepfemndkmdlo; style-src 'self'; "
                         f"img-src 'self' data: blob:{targets}; media-src 'self' blob:{targets}; connect-src 'self'{targets}; "
                         "worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'")
        self.end_headers()

    def _json(self, code, payload, head=False):
        data = json.dumps(payload).encode()
        self._headers(code, 'application/json; charset=utf-8', len(data))
        if not head:
            self.wfile.write(data)

    def do_HEAD(self):
        self._get(head=True)

    def do_GET(self):
        self._get()

    def _get(self, head=False):
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        if path in ('/api/events', '/api/snapshot'):
            if not self._origin_allowed():
                return self._json(403, {'error': 'Cross-origin requests are not allowed.'}, head)
            query = parse_qs(parsed.query)
            camera = query.get('camera', [None])[0]
            session = query.get('session', [None])[0]
            if ((camera and not re.fullmatch(r'[a-f0-9]{16}', camera)) or
                    (session and not re.fullmatch(r'[a-f0-9]{32}', session))):
                return self._json(400, {'error': 'Invalid viewer subscription.'}, head)
            if path == '/api/snapshot':
                return self._json(200, self.server.snapshot(camera, session), head)
            return self._events(camera, session, head)
        if path == '/api/backend':
            return self._json(200, {'id': 'python', 'protocol_version': 1,
                'capabilities': {'discovery': True, 'configuration': True, 'telemetry': True,
                    'serverDvr': True, 'previewFallback': True, 'casting': True, 'localMedia': False}}, head)
        if path == '/api/status':
            if self.server.registry:
                key = parse_qs(parsed.query).get('camera', [None])[0]
                return self._json(200, self.server.registry.status(key), head)
            return self._json(200, self.server.relay.status(), head)
        if path == '/api/cameras' and self.server.registry:
            return self._json(200, self.server.registry.catalog(), head)
        printer_match = re.fullmatch(r'/api/sessions/([a-f0-9]{32})/printer', path)
        if printer_match and self.server.replay:
            try:
                at = float(parse_qs(parsed.query).get('at', [''])[0])
                if not math.isfinite(at) or not 0 <= at <= 2**53 - 1:
                    raise ValueError
            except ValueError:
                return self._json(400, {'error': 'Invalid telemetry time.'}, head)
            payload = self.server.replay.printer_history(printer_match[1], at)
            return self._json(200 if payload else 404, payload or {'error': 'Page buffer expired.'}, head)
        replay_match = re.fullmatch(r'/api/sessions/([a-f0-9]{32})', path)
        if replay_match and self.server.replay:
            payload = self.server.replay.status(replay_match[1])
            return self._json(200 if payload else 404, payload or {'error': 'Page buffer expired.'}, head)
        if path == '/healthz':
            healthy = self.server.registry.healthy() if self.server.registry else self.server.relay.thread.is_alive()
            if self.server.replay:
                healthy = healthy and self.server.replay.thread.is_alive()
            return self._json(200 if healthy else 503, {'ok': healthy}, head)
        video_match = re.fullmatch(r'/replay/([a-f0-9]{32})/video', path)
        if video_match and self.server.replay:
            if not self._origin_allowed():
                return self._json(403, {'error': 'Cross-origin requests are not allowed.'}, head)
            try:
                value = parse_qs(parsed.query).get('start', [None])[0]
                sequence = int(value) if value is not None else None
                if sequence is not None and not 0 <= sequence <= 2**53 - 1:
                    raise ValueError
            except ValueError:
                return self._json(400, {'error': 'Invalid playback position.'}, head)
            return self._video(video_match[1], sequence, head)
        preview_match = re.fullmatch(r'/replay/([a-f0-9]{32})/preview\.jpg', path)
        if preview_match and self.server.replay:
            try:
                at = float(parse_qs(parsed.query).get('at', [''])[0])
                frames = int(parse_qs(parsed.query).get('frames', ['1'])[0])
                if not math.isfinite(at) or not 0 <= at <= 2**53 - 1 or not 1 <= frames <= 6:
                    raise ValueError
            except ValueError:
                return self._json(400, {'error': 'Invalid preview position.'}, head)
            if head:
                return self._json(405, {'error': 'Use GET for thumbnails.'}, head)
            from replay import PreviewBusy
            try:
                data = self.server.replay.preview(preview_match[1], at, frames)
            except PreviewBusy:
                return self._json(503, {'error': 'Thumbnail workers busy.'}, head)
            if not data:
                return self._json(404, {'error': 'Preview unavailable.'}, head)
            try:
                self._headers(200, 'image/jpeg', len(data))
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass  # Leaving the scrub bar cancels an expected thumbnail fetch.
            return
        media_match = re.fullmatch(r'/replay/([a-f0-9]{32})/(live\.m3u8|segment-([0-9]+)\.ts|frame\.jpg)', path)
        replay_file = None
        if media_match and self.server.replay:
            token, name, sequence = media_match.groups()
            if name == 'live.m3u8':
                data = self.server.replay.playlist(token)
                if data is None:
                    return self._json(404, {'error': 'Page buffer expired.'}, head)
                if not data:
                    return self._json(503, {'error': 'Starting the page buffer…'}, head)
                self._headers(200, 'application/vnd.apple.mpegurl', len(data))
                if not head:
                    self.wfile.write(data)
                return
            at = None
            if name == 'frame.jpg':
                try:
                    at = float(parse_qs(parsed.query).get('at', ['0'])[0])
                    if not math.isfinite(at):
                        raise ValueError
                except ValueError:
                    return self._json(400, {'error': 'Invalid playback position.'}, head)
            replay_file = self.server.replay.media(token, sequence=int(sequence) if sequence else None, at=at)
            if not replay_file:
                return self._json(404, {'error': 'Buffered footage is unavailable.'}, head)
        frame_match = re.fullmatch(r'/api/cameras/([a-f0-9]{16})/frame\.jpg', path)
        if frame_match and self.server.registry:
            registry = self.server.registry
            with registry.lock:
                relay = registry.relays.get(frame_match[1])
            if relay and hasattr(relay, 'frame'):
                with relay.lock:
                    frame = relay.frame if relay.state == 'live' else None
                if frame:
                    self._headers(200, 'image/jpeg', len(frame))
                    if not head:
                        self.wfile.write(frame)
                    return
            return self._json(503, {'error': 'Waiting for the camera.'}, head)
        if path == '/service-worker.js':
            data = (STATIC / 'service-worker.js').read_text().replace(
                '__APP_SHELL_REVISION__', APP_SHELL_REVISION).replace(
                '__PWA_CACHE_ENABLED__', json.dumps(PWA_CACHE_ENABLED)).encode()
            self._headers(200, 'text/javascript; charset=utf-8', len(data), shell=True)
            if not head:
                self.wfile.write(data)
            return
        shell = False
        if replay_file:
            file = replay_file
        elif path == '/':
            file = STATIC / 'index.html'
            shell = True
        elif path == '/manifest.webmanifest':
            file = STATIC / 'manifest.webmanifest'
            shell = True
        elif path.startswith('/static/'):
            relative = path.removeprefix('/static/')
            file = (STATIC / relative).resolve()
            if not file.is_relative_to(STATIC.resolve()):
                return self._json(404, {'error': 'Not found.'}, head)
            shell = True
        elif self.server.registry and re.fullmatch(r'/stream/[a-f0-9]{16}/[a-f0-9]{32}/(live\.m3u8|segment-[0-9]+\.ts)', path):
            file = self.server.registry.settings.stream_root / path.removeprefix('/stream/')
        elif self.server.relay and re.fullmatch(r'/stream/[a-f0-9]{32}/(live\.m3u8|segment-[0-9]+\.ts)', path):
            file = self.server.relay.settings.stream_root / path.removeprefix('/stream/')
        else:
            return self._json(404, {'error': 'Not found.'}, head)
        try:
            if not file.is_file():
                return self._json(404, {'error': 'Not found.'}, head)
            with file.open('rb') as source:
                size = os.fstat(source.fileno()).st_size
                content_type = {
                    '.m3u8': 'application/vnd.apple.mpegurl',
                    '.ts': 'video/mp2t',
                    '.js': 'text/javascript; charset=utf-8',
                    '.mjs': 'text/javascript; charset=utf-8',
                    '.css': 'text/css; charset=utf-8',
                    '.html': 'text/html; charset=utf-8',
                    '.webmanifest': 'application/manifest+json; charset=utf-8',
                }.get(file.suffix, mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
                self._headers(200, content_type, size, shell=shell)
                if not head:
                    shutil.copyfileobj(source, self.wfile)
        except FileNotFoundError:
            return self._json(404, {'error': 'Not found.'}, head)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _video(self, token, sequence, head=False):
        update = self.server.replay.video_update(token, sequence=sequence)
        if update is None:
            return self._json(404, {'error': 'Page buffer expired.'}, head)
        self._headers(200, 'application/octet-stream', None, stream=True)
        if head:
            return
        self.connection.settimeout(5)

        def record(metadata, source=None):
            header = json.dumps(metadata, separators=(',', ':'), ensure_ascii=True).encode()
            size = os.fstat(source.fileno()).st_size if source else 0
            if len(header) > 8 * 1024 * 1024 or size > 32 * 1024 * 1024:
                raise OSError('Video record exceeds the streaming limit.')
            self.wfile.write(struct.pack('!II', len(header), size))
            self.wfile.write(header)
            if source:
                shutil.copyfileobj(source, self.wfile, length=64 * 1024)
            self.wfile.flush()

        after = None
        previous = None
        heartbeat = time.monotonic()
        # At most twelve seconds of initial prefetch, then pace archived video
        # at 1x. Live fragments leave as soon as the recorder publishes them.
        due = time.monotonic() - 12
        try:
            self.wfile.write(b'BCV1')
            while not self.server.close_event.is_set():
                if update is None:
                    break  # Session closed/expired; stop holding its lease.
                index, item = update
                revision = (index['start'], index['last'], index['target'])
                if revision != previous:
                    record(index)
                    previous = revision
                    after = index['last']
                now = time.monotonic()
                if item and now >= due:
                    try:
                        with item.file.open('rb') as source:
                            record({'type': 'segment', 'sequence': item.sequence}, source)
                    except FileNotFoundError:
                        pass  # The storage cap can trim between lookup and IO.
                    sequence = item.sequence + 1
                    due = max(due, now - 12) + item.duration
                if now - heartbeat >= 15:
                    record({'type': 'heartbeat'})
                    heartbeat = now
                if self.server.close_event.wait(0.1 if item and now >= due else 0.25):
                    break
                update = self.server.replay.video_update(token, after, sequence)
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass

    def _events(self, camera, session, head=False):
        self._headers(200, 'text/event-stream; charset=utf-8', None, stream=True)
        if head:
            return
        self.connection.settimeout(5)
        previous = {}
        telemetry_after = None
        heartbeat = time.monotonic()
        try:
            self.wfile.write(b'retry: 5000\n\n')
            self.wfile.flush()
            while not self.server.close_event.is_set():
                snapshot = self.server.snapshot(camera, session, telemetry_after)
                patch = {'version': 1, 'session_id': session}
                for key in ('catalog', 'status', 'replay', 'telemetry'):
                    if key not in snapshot:
                        continue
                    value = snapshot[key]
                    comparable = ({k: v for k, v in value.items()
                                   if k not in ('uptime_seconds', 'last_segment_age_seconds')}
                                  if key == 'status' else value)
                    if key == 'telemetry' and value:
                        comparable = value['cursor']
                        telemetry_after = value['cursor']
                    if key not in previous or previous[key] != comparable:
                        previous[key] = comparable
                        patch[key] = value
                if len(patch) > 2:
                    data = json.dumps(patch, separators=(',', ':'), ensure_ascii=True)
                    self.wfile.write(f'event: state\ndata: {data}\n\n'.encode())
                    self.wfile.flush()
                if time.monotonic() - heartbeat >= 15:
                    self.wfile.write(b'event: heartbeat\ndata: {}\n\n')
                    self.wfile.flush()
                    heartbeat = time.monotonic()
                if self.server.close_event.wait(0.5):
                    break
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass  # A tab or proxy can disconnect at any point in the stream.

    def do_POST(self):
        # Commands are infrequent. Close their connection so rejected requests
        # with an unread body cannot be parsed as a second HTTP request.
        self.close_connection = True
        parsed = urlsplit(self.path)
        path = parsed.path
        configure_match = re.fullmatch(r'/api/cameras/([a-f0-9]{16})/configure', path)
        forget_match = re.fullmatch(r'/api/cameras/([a-f0-9]{16})/forget', path)
        close_match = re.fullmatch(r'/api/sessions/([a-f0-9]{32})/close', path)
        if path not in ('/api/restart', '/api/discover', '/api/sessions') and not configure_match and not forget_match and not close_match:
            return self._json(404, {'error': 'Not found.'})
        # A cross-origin page cannot set this header without a successful CORS
        # preflight. Only explicitly trusted hosted frontends receive permission.
        if self.headers.get('X-Viewer-Request') != '1':
            return self._json(403, {'error': 'Use the viewer to manage cameras.'})
        if not self._origin_allowed():
            return self._json(403, {'error': 'Cross-origin requests are not allowed.'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self._json(400, {'error': 'Invalid request length.'})
        if not 0 <= length <= 2048:
            return self._json(413, {'error': 'Request is too large.'})
        self.connection.settimeout(6)
        try:
            payload = json.loads(self.rfile.read(length)) if length else {}
        except (ValueError, OSError):
            return self._json(400, {'error': 'Invalid request.'})
        if not isinstance(payload, dict):
            return self._json(400, {'error': 'Invalid request.'})
        registry = self.server.registry
        if path == '/api/sessions' or close_match:
            if not self.server.replay:
                return self._json(404, {'error': 'Page history is unavailable.'})
            if close_match:
                self.server.replay.release(close_match[1])
                return self._json(200, {'ok': True})
            key = payload.get('camera_id')
            if not isinstance(key, str) or not re.fullmatch(r'[a-f0-9]{16}', key):
                return self._json(400, {'error': 'Choose a configured printer first.'})
            try:
                session = self.server.replay.create(key)
            except ValueError as error:
                return self._json(409, {'error': str(error)})
            except OSError:
                return self._json(503, {'error': 'The rewind buffer is unavailable.'})
            return self._json(201, session)
        if path == '/api/discover':
            if not registry:
                return self._json(404, {'error': 'Discovery is unavailable.'})
            queued = registry.discovery.start()
            return self._json(202, {'ok': True, 'queued': queued,
                                    'retry_after_seconds': registry.discovery.retry_after(),
                                    'discovery': registry.discovery.status()})
        if configure_match:
            if not registry:
                return self._json(404, {'error': 'Printer is unavailable.'})
            if set(payload) - {'access_code'}:
                return self._json(400, {'error': 'Only this printer’s LAN access code can be configured.'})
            try:
                registry.configure(configure_match[1], payload.get('access_code'))
            except ValueError as error:
                return self._json(400, {'error': str(error)})
            except OSError:
                return self._json(500, {'error': 'Could not save the camera connection.'})
            return self._json(200, {'ok': True})
        if forget_match:
            if not registry:
                return self._json(404, {'error': 'Printer is unavailable.'})
            key = forget_match[1]
            try:
                registry.forget(key)
            except ValueError as error:
                return self._json(400, {'error': str(error)})
            except OSError:
                return self._json(500, {'error': 'Could not forget the printer.'})
            if self.server.replay:
                self.server.replay.forget(key)
            return self._json(200, {'ok': True})
        if registry:
            key = parse_qs(parsed.query).get('camera', [None])[0] or registry.catalog()['default_camera_id']
            relay = registry.get_relay(key)
            if not relay:
                return self._json(409, {'error': 'Choose a printer and enter its access code first.'})
        else:
            relay = self.server.relay
        queued = relay.request_restart()
        self._json(202, {'ok': True, 'queued': queued})


def main():
    from cameras import CameraRegistry
    from replay import ReplayBuffer

    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    try:
        settings = Settings.from_env()
    except ValueError as error:
        LOG.error('%s', error)
        raise SystemExit(2) from None
    try:
        registry = CameraRegistry(settings, Relay)
        replay = ReplayBuffer(registry)
    except ValueError as error:
        LOG.error('%s', error)
        raise SystemExit(2) from None
    server = ViewerServer(('0.0.0.0', settings.port), registry=registry, replay=replay)
    registry.start()
    replay.start()

    def shutdown(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    LOG.info('Browser viewer listening on port %s.', settings.port)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        replay.close()
        registry.close()


if __name__ == '__main__':
    main()
