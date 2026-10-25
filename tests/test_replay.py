import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app import ViewerServer
from replay import ReplayBuffer


CAMERA = '1234567890abcdef'


class Source:
    def __init__(self, root):
        self.lock = threading.Lock()
        self.generation = 'a' * 32
        self.directory = root / self.generation
        self.directory.mkdir()
        self.thread = threading.current_thread()

    def publish(self, numbers):
        lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:2']
        for number in numbers:
            filename = f'segment-{number:010d}.ts'
            (self.directory / filename).write_bytes(f'frame-{self.generation[0]}-{number}'.encode())
            lines.extend(['#EXTINF:2.0,', filename])
        temporary = self.directory / 'manifest.tmp'
        temporary.write_text('\n'.join(lines) + '\n')
        temporary.replace(self.directory / 'live.m3u8')


class Registry:
    def __init__(self, source):
        self.source = source

    def get_relay(self, camera):
        return self.source if camera == CAMERA else None

    def healthy(self):
        return True


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = Source(self.root)
        self.source.publish([1, 2, 3])
        self.registry = Registry(self.source)
        self.replay = ReplayBuffer(self.registry, root=self.root / 'buffer', max_bytes=1024 * 1024, timeout=10)
        self.replay.start()
        self.addCleanup(self.replay.close)

    def wait_duration(self, token, duration):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            metadata = self.replay.status(token)
            if metadata and metadata['end_seconds'] >= duration:
                return metadata
            time.sleep(0.03)
        self.fail('The page buffer stopped collecting new footage.')

    def test_forgetting_a_printer_releases_every_viewer_and_deletes_its_history(self):
        other_camera = 'fedcba0987654321'
        self.registry.get_relay = lambda key: self.source if key in (CAMERA, other_camera) else None
        first = self.replay.create(CAMERA)
        second = self.replay.create(CAMERA)
        other = self.replay.create(other_camera)
        self.assertTrue(list(self.replay.root.iterdir()))
        self.replay.forget(CAMERA)
        self.assertIsNone(self.replay.status(first['session_id']))
        self.assertIsNone(self.replay.status(second['session_id']))
        self.assertNotIn(CAMERA, self.replay.archives)
        self.assertIsNotNone(self.replay.status(other['session_id']))
        self.assertEqual(list(self.replay.root.iterdir()), [self.replay.archives[other_camera].directory])

    def test_starts_with_page_and_keeps_video_after_live_segments_are_deleted(self):
        self.assertEqual(list(self.replay.root.iterdir()), [], 'No history should be recorded without an open page.')
        session = self.replay.create(CAMERA)
        token = session['session_id']
        first = self.replay.media(token, sequence=0)
        self.assertEqual(first.read_bytes(), b'frame-a-3', 'Older live-window footage must not be imported.')
        self.source.publish(range(3, 9))
        self.wait_duration(token, 12)
        self.source.publish(range(8, 14))
        self.wait_duration(token, 22)
        for file in self.source.directory.glob('segment-*.ts'):
            if int(file.stem.split('-')[1]) < 8:
                file.unlink()
        self.assertEqual(first.read_bytes(), b'frame-a-3')
        playlist = self.replay.playlist(token).decode()
        self.assertIn('#EXT-X-PLAYLIST-TYPE:EVENT', playlist)
        self.assertIn('segment-0.ts', playlist)
        self.assertGreater(playlist.count('#EXTINF:'), 6)

    def test_tabs_have_independent_start_points_and_close_releases_only_unused_history(self):
        first = self.replay.create(CAMERA)['session_id']
        old_file = self.replay.media(first, sequence=0)
        self.source.publish(range(3, 7))
        self.wait_duration(first, 8)
        second = self.replay.create(CAMERA)['session_id']
        self.assertFalse(self.replay.status(second)['ready'])
        self.assertIsNone(self.replay.media(second, sequence=0), 'New pages must not access an older tab’s footage.')
        self.source.publish(range(4, 8))
        self.wait_duration(second, 2)
        self.assertEqual(self.replay.status(first)['end_seconds'], 10)
        self.replay.release(first)
        self.assertFalse(old_file.exists())
        self.assertIsNotNone(self.replay.status(second))
        self.replay.release(second)
        self.assertEqual(list(self.replay.root.iterdir()), [])

    def test_relay_reconnect_preserves_history_and_marks_timestamp_discontinuity(self):
        token = self.replay.create(CAMERA)['session_id']
        with self.source.lock:
            self.source.generation = 'b' * 32
            self.source.directory = self.root / self.source.generation
            self.source.directory.mkdir()
        self.source.publish([1, 2])
        self.wait_duration(token, 6)
        playlist = self.replay.playlist(token).decode()
        self.assertIn('#EXT-X-DISCONTINUITY\n', playlist)
        self.assertEqual(self.replay.media(token, sequence=0).read_bytes(), b'frame-a-3')
        self.assertEqual(self.replay.media(token, sequence=1).read_bytes(), b'frame-b-1')

    def test_storage_cap_trims_oldest_footage_without_losing_current_stream(self):
        self.replay.max_bytes = 25
        token = self.replay.create(CAMERA)['session_id']
        self.source.publish(range(3, 9))
        self.wait_duration(token, 12)
        metadata = self.replay.status(token)
        self.assertTrue(metadata['limited'])
        self.assertGreater(metadata['start_seconds'], 0)
        self.assertIsNone(self.replay.media(token, sequence=0))
        self.assertNotIn('#EXT-X-PLAYLIST-TYPE:EVENT', self.replay.playlist(token).decode())

    def test_expired_and_reloaded_pages_get_fresh_buffers(self):
        token = self.replay.create(CAMERA)['session_id']
        with patch('replay.time.monotonic', return_value=time.monotonic() + 11):
            self.assertIsNone(self.replay.status(token))
            self.replay.release('nonexistent')
        self.assertEqual(list(self.replay.root.iterdir()), [])
        replacement = self.replay.create(CAMERA)
        self.assertNotEqual(replacement['session_id'], token)
        self.assertEqual(replacement['end_seconds'], 2)

    def test_native_jpeg_history_can_be_scrubbed_independently_of_live_image(self):
        self.source.frame = b'jpeg-one'
        self.source.last_segment_at = 100
        self.source.state = 'live'
        token = self.replay.create(CAMERA)['session_id']
        with self.source.lock:
            self.source.frame = b'jpeg-two'
            self.source.last_segment_at = 102
        self.wait_duration(token, 3)
        self.assertEqual(self.replay.media(token, at=0).read_bytes(), b'jpeg-one')
        self.assertEqual(self.replay.media(token, at=2).read_bytes(), b'jpeg-two')

    def test_http_session_lifecycle_and_cross_origin_protection(self):
        server = ViewerServer(('127.0.0.1', 0), registry=self.registry, replay=self.replay)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_port}'
        payload = json.dumps({'camera_id': CAMERA}).encode()
        for headers in [{}, {'X-Viewer-Request': '1', 'Origin': 'https://other.example'}]:
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(base + '/api/sessions', data=payload, headers=headers), timeout=3)
            self.assertEqual(error.exception.code, 403)
        with urlopen(Request(base + '/api/sessions', data=payload, headers={'X-Viewer-Request': '1'}), timeout=3) as response:
            session = json.load(response)
        token = session['session_id']
        with urlopen(base + session['playlist_url'], timeout=3) as response:
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertIn(b'segment-0.ts', response.read())
        with urlopen(base + f'/replay/{token}/segment-0.ts', timeout=3) as response:
            self.assertEqual(response.read(), b'frame-a-3')
        with urlopen(Request(base + f'/api/sessions/{token}/close', data=b'{}', headers={'X-Viewer-Request': '1'}), timeout=3):
            pass
        with self.assertRaises(HTTPError) as error:
            urlopen(base + f'/api/sessions/{token}', timeout=3)
        self.assertEqual(error.exception.code, 404)


if __name__ == '__main__':
    unittest.main()
