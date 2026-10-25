from dataclasses import replace
import io
import json
import logging
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import Relay, Settings, ViewerServer, ffmpeg_command, safe_error

FAKE_SOURCE = 'rtsps://example-user:private-fixture-token@192.0.2.1:322/live'


class SettingsTests(unittest.TestCase):
    def test_invalid_configuration_fails_without_exposing_source(self):
        for value in ['ftp://camera/live', 'rtsps://user:secret@camera:bad/live', 'rtsp://camera/live\nmalformed']:
            with self.subTest(value=value), patch.dict(os.environ, {'STREAM_URL': value}, clear=True):
                with self.assertRaises(ValueError) as error:
                    Settings.from_env()
                self.assertNotIn('secret', str(error.exception))

    def test_empty_source_allows_discovery_without_an_existing_printer(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(Settings.from_env().stream_url, '')

    def test_nonfinite_watchdog_configuration_is_rejected(self):
        with patch.dict(os.environ, {'STREAM_URL': FAKE_SOURCE, 'STALE_TIMEOUT_SECONDS': 'nan'}, clear=True):
            with self.assertRaises(ValueError):
                Settings.from_env()

    def test_redacts_urls_and_credentials_in_ffmpeg_errors(self):
        message = safe_error(f'Input {FAKE_SOURCE}: example-user private-fixture-token invalid', FAKE_SOURCE)
        self.assertNotIn('rtsps://', message)
        self.assertNotIn('example-user', message)
        self.assertNotIn('private-fixture-token', message)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        binary = root / 'bin'
        binary.mkdir()
        fake = binary / 'ffmpeg'
        fake.write_text(f'''#!{sys.executable}
import os, pathlib, sys, time
playlist=pathlib.Path(sys.argv[-1])
(playlist.parent/'pid').write_text(str(os.getpid()))
print('Input '+sys.argv[sys.argv.index('-i')+1], file=sys.stderr, flush=True)
i=0
while True:
 i+=1
 segment=playlist.parent/('segment-'+str(i)+'.ts')
 segment.write_bytes(b'fixture-media')
 temporary=playlist.with_suffix('.tmp')
 temporary.write_text(chr(10).join(['#EXTM3U','#EXT-X-MEDIA-SEQUENCE:'+str(i),'#EXTINF:2.0,',segment.name,'']))
 temporary.replace(playlist)
 time.sleep(0.12)
''')
        fake.chmod(0o755)
        # Docker mounts /tmp with noexec. Read the fixture through Python,
        # while keeping real subprocess creation, termination and HTTP I/O.
        self.command = patch('app.ffmpeg_command', lambda settings, directory:
                             [sys.executable, str(fake), *ffmpeg_command(settings, directory)[1:]])
        self.command.start()
        self.logs = io.StringIO()
        self.log_handler = logging.StreamHandler(self.logs)
        logging.getLogger('camera-viewer').addHandler(self.log_handler)
        settings = replace(Settings(FAKE_SOURCE), stream_root=root / 'hls', stale_timeout=0.7, reconnect_delay=0.1)
        self.relay = Relay(settings)
        self.server = ViewerServer(('127.0.0.1', 0), self.relay)
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.relay.start()
        self.http = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.http.start()
        self.addCleanup(self.cleanup_relay)
        self.wait(lambda: self.status()['state'] == 'live')

    def cleanup_relay(self):
        self.server.shutdown()
        self.server.server_close()
        self.relay.close()
        self.http.join(timeout=2)
        self.command.stop()
        logging.getLogger('camera-viewer').removeHandler(self.log_handler)
        self.assertFalse(self.relay.thread.is_alive(), 'Relay did not shut down cleanly.')
        self.assertNotIn('private-fixture-token', self.logs.getvalue())
        self.temp.cleanup()

    @staticmethod
    def wait(predicate, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.08)
        raise AssertionError('Timed out waiting for relay recovery.')

    def get(self, path):
        return urlopen(self.base + path, timeout=3)

    def status(self):
        with self.get('/api/status') as response:
            return json.load(response)

    def current_pid(self):
        generation = self.status()['generation']
        return int((self.relay.settings.stream_root / generation / 'pid').read_text())

    def test_http_serves_video_without_disclosing_camera_credentials(self):
        status = self.status()
        self.assertNotIn('private-fixture-token', json.dumps(status))
        with self.get(status['playlist_url']) as response:
            self.assertEqual(response.headers['Content-Type'], 'application/vnd.apple.mpegurl')
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            manifest = response.read().decode()
        segment = [line for line in manifest.splitlines() if line.endswith('.ts')][0]
        with self.get(status['playlist_url'].replace('live.m3u8', segment)) as response:
            self.assertEqual(response.headers['Content-Type'], 'video/mp2t')
            self.assertEqual(response.read(), b'fixture-media')
        for path in ['/static/../../app.py', '/static/%2e%2e/%2e%2e/.env', '/stream/not-a-generation/live.m3u8']:
            with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                self.get(path)
            self.assertEqual(error.exception.code, 404)

    def test_native_module_assets_have_javascript_mime_types(self):
        for path in ['/static/player.js', '/static/vendor/hls.min.mjs', '/static/vendor/hls.worker.js']:
            with self.subTest(path=path), self.get(path) as response:
                self.assertEqual(response.headers['Content-Type'], 'text/javascript; charset=utf-8')
                self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
                self.assertTrue(response.read())

    def test_manual_restart_replaces_playlist_and_refuses_cross_origin_requests(self):
        old = self.status()
        for headers in [{}, {'X-Viewer-Request': '1', 'Origin': 'https://other.example'}]:
            request = Request(self.base + '/api/restart', data=b'{}', headers=headers)
            with self.assertRaises(HTTPError) as error:
                urlopen(request, timeout=3)
            self.assertEqual(error.exception.code, 403)
        request = Request(self.base + '/api/restart', data=b'{}', headers={'X-Viewer-Request': '1'})
        with urlopen(request, timeout=3) as response:
            self.assertEqual(response.status, 202)
        self.wait(lambda: self.status()['generation'] != old['generation'] and self.status()['state'] == 'live')
        with self.assertRaises(HTTPError) as error:
            self.get(old['playlist_url'])
        self.assertEqual(error.exception.code, 404)

    def test_auto_recovers_when_camera_process_exits(self):
        old = self.status()['generation']
        os.kill(self.current_pid(), signal.SIGKILL)
        self.wait(lambda: self.status()['generation'] != old and self.status()['state'] == 'live')
        self.assertGreaterEqual(self.status()['restarts'], 1)

    def test_watchdog_recovers_when_camera_process_hangs(self):
        old = self.status()['generation']
        os.kill(self.current_pid(), signal.SIGSTOP)
        self.wait(lambda: self.status()['generation'] != old and self.status()['state'] == 'live')
        self.assertGreaterEqual(self.status()['restarts'], 1)


if __name__ == '__main__':
    unittest.main()
