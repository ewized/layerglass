import errno
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


class JpegSource:
    def __init__(self, timestamp=1000):
        self.lock = threading.Lock()
        self.publish(timestamp)

    def publish(self, timestamp):
        with self.lock:
            self.state = 'live'
            self.last_segment_at = timestamp
            self.frame = f'jpeg-at-{timestamp}'.encode()


class JpegReplayTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.source = JpegSource()
        self.registry = Registry(self.source)
        self.replay = ReplayBuffer(self.registry, root=Path(temporary.name), timeout=10)
        self.addCleanup(self.replay.close)
        self.now = 1000
        clock = patch('replay.time.time', side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        self.token = self.replay.create(CAMERA)['session_id']

    def capture(self, timestamp):
        self.now = timestamp
        self.source.publish(timestamp)
        with self.replay.lock:
            self.replay._collect(self.replay.archives[CAMERA], self.source)

    def test_retired_already_absent_directory_releases_ownership(self):
        archive = self.replay.archives[CAMERA]
        archive.fragments[0].file.unlink()
        archive.directory.rmdir()
        self.replay.release(self.token)
        self.assertFalse(self.replay.sessions)
        self.assertFalse(self.replay.archives)

    def test_missing_child_during_retired_cleanup_keeps_remaining_tree(self):
        archive = self.replay.archives[CAMERA]
        with patch('replay.shutil.rmtree', side_effect=FileNotFoundError(errno.ENOENT, 'Fixture missing child.')):
            with self.assertRaises(FileNotFoundError):
                self.replay.release(self.token)
            self.assertFalse(self.replay.sessions)
            self.assertIs(self.replay.archives[CAMERA], archive)
        self.replay._prune()
        self.assertFalse(archive.directory.exists())
        self.assertFalse(self.replay.archives)

    def test_shutdown_cleanup_fault_keeps_ownership_without_interrupting_shutdown(self):
        archive = self.replay.archives[CAMERA]
        self.replay.thread.start()
        self.assertTrue(self.replay.thread.is_alive())
        with patch('replay.shutil.rmtree', side_effect=PermissionError(errno.EACCES, 'Fixture shutdown cleanup failure.')):
            with self.assertLogs('printer-camera', level='WARNING'):
                self.replay.close()
            self.assertTrue(self.replay.stop_event.is_set())
            self.assertFalse(self.replay.thread.is_alive())
            self.assertFalse(self.replay.sessions)
            self.assertIs(self.replay.archives[CAMERA], archive)
            self.assertTrue(archive.fragments[0].file.exists())
        # A live worker was stopped; only this explicit later cleanup retries.
        self.replay.close()
        self.assertFalse(self.replay.archives)

    def test_owned_jpeg_descriptor_and_selector_keep_precise_completed_positions(self):
        self.capture(1030.123456)
        snapshot = self.replay.status(self.token)
        frame = snapshot['jpeg_frame']
        self.assertEqual(frame, {'sequence': 1, 'start': 0, 'position': 1030.123456 - 1000,
                                 'time': 1030.123456, 'clock': [{'position': 0, 'time': 1000}]})
        self.assertNotEqual(frame['position'], snapshot['end_seconds'] - 1)
        self.capture(1030.250789)
        self.assertEqual(self.replay.image(self.token, frame['sequence']).read_bytes(), b'jpeg-at-1030.123456')
        self.assertEqual(self.replay.image(self.token, frame['sequence'], frame['position']).read_bytes(), b'jpeg-at-1030.123456')
        self.assertEqual(self.replay.image(self.token, frame['sequence'], frame['position'] - 0.000001).read_bytes(), b'jpeg-at-1000')
        self.assertIsNone(self.replay.image(self.token, frame['sequence'], frame['position'] + 0.000001))
        self.assertIsNone(self.replay.image(self.token, frame['sequence'], -0.1))
        self.assertIsNone(self.replay.image(self.token, 999))
        self.assertIsNone(self.replay.image(self.token, True))
        self.assertIsNone(self.replay.image(self.token, 1, float('nan')))
        # A selected position in the completed held interval keeps its wall
        # clock, rather than being moved to the held image's capture start.
        self.assertEqual(self.replay.image(self.token, 2, 20).read_bytes(), b'jpeg-at-1000')

    def test_owned_selector_excludes_old_pages_and_retained_or_expired_media(self):
        self.now = 1020.123456
        later = self.replay.create(CAMERA)['session_id']
        self.assertIsNone(self.replay.status(later)['jpeg_frame'])
        self.capture(1030.250789)
        frame = self.replay.status(later)['jpeg_frame']
        self.assertEqual(frame['start'], frame['position'])
        self.assertAlmostEqual(frame['position'], 10.127333)
        self.assertEqual(frame['clock'][0]['time'], 1000)
        self.assertAlmostEqual(frame['clock'][0]['position'], -20.123456, places=12)
        self.assertIsNone(self.replay.image(later, 0))
        self.assertIsNone(self.replay.image(later, 1, frame['position'] - 0.000001))
        self.assertEqual(self.replay.image(later, 1, frame['position']).read_bytes(), b'jpeg-at-1030.250789')
        self.capture(1031.125678)
        self.replay.max_bytes = 1
        with self.replay.lock:
            self.replay._prune()
        self.assertIsNone(self.replay.image(later, 1))
        self.assertIsNone(self.replay.image(later, 2, frame['position']))
        self.assertIsNotNone(self.replay.image(later, 2))
        self.replay.release(later)
        self.assertIsNone(self.replay.image(later, 2))

    def test_http_owned_selector_is_optional_and_validates_coverage_and_identity(self):
        self.capture(1030.123456)
        server = ViewerServer(('127.0.0.1', 0), registry=self.registry, replay=self.replay)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        path = f'http://127.0.0.1:{server.server_port}/replay/{self.token}/frame.jpg'
        for query, expected in [('?frame=0', b'jpeg-at-1000'), ('?frame=1', b'jpeg-at-1030.123456'),
                                ('?frame=1&at=20', b'jpeg-at-1000'), ('?at=20', b'jpeg-at-1000'),
                                ('?at=20&at=999', b'jpeg-at-1000'), ('?at=', b'jpeg-at-1000')]:
            with urlopen(path + query, timeout=3) as response:
                self.assertEqual(response.read(), expected)
                self.assertEqual(response.headers['Content-Type'], 'image/jpeg')
        for query in ['?frame=', '?frame=-1', '?frame=0.5', '?frame=0&frame=1', '?frame=01',
                      '?frame=99999999999999999999', '?frame=0&at=nan', '?frame=0&at=0&at=1']:
            with self.assertRaises(HTTPError) as error:
                urlopen(path + query, timeout=3)
            self.assertEqual(error.exception.code, 400, query)
        for query in ['?frame=999', '?frame=0&at=0.1', '?frame=1&at=-1']:
            with self.assertRaises(HTTPError) as error:
                urlopen(path + query, timeout=3)
            self.assertEqual(error.exception.code, 404, query)

    def worker_tick(self):
        # Run the actual maintenance/error handler for one deterministic tick.
        with patch.object(self.replay.stop_event, 'wait', side_effect=[False, True]):
            self.replay._run()

    def capture_state(self, archive):
        return (archive.position, archive.last_jpeg_position, archive.last_jpeg_at, archive.sequence,
                [(item.sequence, item.start, item.duration) for item in archive.fragments], list(archive.clocks))

    def fail_written_frame_stat(self, archive):
        successor = archive.directory / f'frame-{archive.sequence}.jpg'
        stat = Path.stat
        self.stat_failures = []

        def fail(path, *args, **kwargs):
            if path == successor:
                self.assertEqual(path.read_bytes(), self.source.frame, 'Inject only after the actual frame write.')
                self.stat_failures.append(path)
                raise OSError(errno.EIO, 'Fixture post-write JPEG metadata failure.')
            return stat(path, *args, **kwargs)

        return patch.object(Path, 'stat', fail)

    def test_caught_stat_failure_preserves_tail_and_same_capture_retry(self):
        self.now = 1020
        later = self.replay.create(CAMERA)['session_id']
        archive = self.replay.archives[CAMERA]
        before = self.capture_state(archive)
        self.now = 1030
        self.source.publish(1030)
        with self.fail_written_frame_stat(archive), self.assertLogs('printer-camera', level='WARNING'):
            self.worker_tick()
        self.assertEqual(len(self.stat_failures), 1)
        self.assertEqual(self.capture_state(archive), before)
        self.assertEqual(self.replay.sessions[later].origin, 20)
        self.assertEqual(archive.error, 'The rewind buffer is temporarily unavailable.')
        self.worker_tick()  # Retry the exact same captured frame through the caught-error path.
        self.assertIsNone(archive.error)
        self.assertEqual(self.replay.status(later)['start_seconds'], 10)
        for epoch in range(1031, 1066):
            self.capture(epoch)
        self.assertEqual([item.start for item in list(archive.fragments)[:3]], [0, 30, 31])
        self.assertEqual(self.replay.media(self.token, at=30.5).read_bytes(), b'jpeg-at-1030')
        self.assertEqual(self.replay.media(self.token, at=31.1).read_bytes(), b'jpeg-at-1031')
        self.assertEqual(self.replay.status(self.token)['clock'], [{'position': 0, 'time': 1000}])

    def test_skipping_failed_capture_preserves_new_page_origin_and_retention(self):
        archive = self.replay.archives[CAMERA]
        before = self.capture_state(archive)
        self.now = 1030
        self.source.publish(1030)
        with self.fail_written_frame_stat(archive), self.assertLogs('printer-camera', level='WARNING'):
            self.worker_tick()
        self.assertEqual(self.capture_state(archive), before)
        self.source.state = 'reconnecting'
        self.now = 1030.2
        later = self.replay.create(CAMERA)['session_id']
        self.assertAlmostEqual(self.replay.sessions[later].origin, 30.2)
        self.assertFalse(self.replay.status(later)['ready'])
        self.capture(1031)  # The failed 1030 capture is no longer the live image.
        self.assertEqual([item.start for item in archive.fragments], [0, 31])
        self.assertEqual(self.replay.status(later)['start_seconds'], 0.8)
        self.assertEqual(self.replay.status(later)['clock'], [{'position': -30.2, 'time': 1000}])
        self.assertIsNone(self.replay.media(later, sequence=0))
        self.assertEqual(self.replay.media(later, at=0.8).read_bytes(), b'jpeg-at-1031')
        self.replay.release(self.token)
        self.replay.max_bytes = 1
        self.now = 1031.025
        self.source.publish(self.now)
        self.worker_tick()
        self.assertEqual(len(archive.fragments), 1)
        self.assertAlmostEqual(archive.fragments[0].start, 31.025)
        self.assertAlmostEqual(archive.last_jpeg_position, 31.025)
        self.assertEqual(archive.last_jpeg_at, 1031.025)
        self.assertEqual(self.replay.status(later)['start_seconds'], 0.825)
        self.assertTrue(self.replay.status(later)['limited'])

    def test_first_jpeg_stat_failure_leaves_no_unpublished_clock_anchor(self):
        self.replay.release(self.token)
        self.source.state = 'reconnecting'
        self.now = 1020
        token = self.replay.create(CAMERA)['session_id']
        archive = self.replay.archives[CAMERA]
        before = self.capture_state(archive)
        self.now = 1030
        self.source.publish(1030)
        with self.fail_written_frame_stat(archive), self.assertLogs('printer-camera', level='WARNING'):
            self.worker_tick()
        self.assertEqual(len(self.stat_failures), 1)
        self.assertEqual(self.capture_state(archive), before)
        self.assertFalse(self.replay.status(token)['ready'])
        self.worker_tick()
        self.assertTrue(self.replay.status(token)['ready'])
        self.assertEqual(self.replay.status(token)['clock'], [{'position': 0, 'time': 1030}])

    def test_positive_capture_intervals_finalize_only_the_preceding_still(self):
        for timestamp in (1000.25, 1001.75, 1030, 1031):
            self.capture(timestamp)
        fragments = self.replay.archives[CAMERA].fragments
        self.assertEqual([item.start for item in fragments], [0, 0.25, 1.75, 30, 31])
        self.assertEqual([item.duration for item in fragments], [0.25, 1.5, 28.25, 1, 1])
        self.assertEqual(self.replay.media(self.token, at=0.1).read_bytes(), b'jpeg-at-1000')
        self.assertEqual(self.replay.media(self.token, at=29.9).read_bytes(), b'jpeg-at-1001.75')
        self.assertEqual(self.replay.media(self.token, at=30.5).read_bytes(), b'jpeg-at-1030')
        self.assertEqual(self.replay.media(self.token, at=31.1).read_bytes(), b'jpeg-at-1031')
        metadata = self.replay.status(self.token)
        self.assertEqual(metadata['clock'], [{'position': 0, 'time': 1000}])
        self.assertEqual((metadata['end_seconds'], metadata['end_time']), (32, 1031))
        self.capture(1031)
        self.assertEqual(len(fragments), 5, 'An unchanged capture timestamp must not duplicate a frame.')

    def test_waiting_page_origin_survives_a_subsecond_tail_shrink(self):
        self.now = 1000.2
        later = self.replay.create(CAMERA)['session_id']
        self.assertFalse(self.replay.status(later)['ready'])
        self.capture(1000.35)
        metadata = self.replay.status(later)
        self.assertAlmostEqual(self.replay.sessions[later].origin, 0.2)
        self.assertEqual(metadata['start_seconds'], 0.15)
        self.assertEqual(metadata['clock'], [{'position': -0.2, 'time': 1000}])
        self.assertAlmostEqual(metadata['clock'][0]['time'] + metadata['start_seconds'] -
                               metadata['clock'][0]['position'], 1000.35)
        self.assertEqual(self.replay.media(later, at=0.15).read_bytes(), b'jpeg-at-1000.35')
        self.assertIsNone(self.replay.media(later, sequence=0))
        self.capture(1000.5)
        self.assertEqual(self.replay.status(later)['start_seconds'], 0.15)
        self.assertAlmostEqual(self.replay.sessions[later].origin, 0.2)

    def test_positive_intervals_below_a_tenth_second_are_not_padded(self):
        for timestamp in (1000.025, 1000.05, 1000.075):
            self.capture(timestamp)
        fragments = list(self.replay.archives[CAMERA].fragments)
        for item, expected in zip(fragments, (0, 0.025, 0.05, 0.075)):
            self.assertAlmostEqual(item.start, expected)
        for item in fragments[:-1]:
            self.assertAlmostEqual(item.duration, 0.025)
        self.assertEqual(self.replay.status(self.token)['clock'], [{'position': 0, 'time': 1000}])
        self.assertEqual(self.replay.media(self.token, at=0.06).read_bytes(), b'jpeg-at-1000.05')

    def test_gap_waiting_page_keeps_its_open_clock_after_the_earlier_page_leaves(self):
        self.now = 1020
        later = self.replay.create(CAMERA)['session_id']
        self.assertEqual(self.replay.sessions[later].opened_at, 1020)
        self.assertEqual(self.replay.sessions[later].origin, 20)
        self.assertFalse(self.replay.status(later)['ready'])
        self.replay.release(self.token)
        self.assertFalse(self.replay.archives[CAMERA].fragments)
        self.capture(1030)
        metadata = self.replay.status(later)
        self.assertEqual((metadata['start_seconds'], metadata['end_seconds']), (10, 11))
        self.assertEqual(metadata['clock'], [{'position': -20, 'time': 1000}])
        self.assertEqual(self.replay.media(later, at=10).read_bytes(), b'jpeg-at-1030')
        self.assertIsNone(self.replay.media(later, sequence=0))
        self.assertIsNone(self.replay.preview(later, 0))

    def test_page_opened_after_the_gap_starts_at_its_actual_wall_time(self):
        self.capture(1030)
        self.now = 1030.2
        later = self.replay.create(CAMERA)['session_id']
        self.capture(1030.4)
        metadata = self.replay.status(later)
        self.assertAlmostEqual(self.replay.sessions[later].origin, 30.2)
        self.assertEqual(metadata['start_seconds'], 0.2)
        self.assertEqual(metadata['clock'], [{'position': -30.2, 'time': 1000}])
        self.assertEqual(self.replay.media(later, at=0.2).read_bytes(), b'jpeg-at-1030.4')
        self.assertIsNone(self.replay.media(later, sequence=1))
        self.assertEqual(self.replay.status(self.token)['clock'], [{'position': 0, 'time': 1000}])


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
        self.assertNotIn('jpeg_frame', session, 'HLS metadata and delivery are unchanged')
        self.assertIsNone(self.replay.image(token, 0), 'The optional JPEG selector cannot select HLS media')
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

    def test_current_fragment_larger_than_the_target_keeps_collecting(self):
        self.replay.max_bytes = 1
        token = self.replay.create(CAMERA)['session_id']
        self.source.publish([3, 4, 5])
        self.wait_duration(token, 6)
        archive = self.replay.archives[CAMERA]
        with self.replay.lock:
            self.assertEqual(len(archive.fragments), 1)
            self.assertGreater(archive.fragments[0].size, self.replay.max_bytes)
            self.assertEqual(archive.fragments[0].file.read_bytes(), b'frame-a-5')
            self.assertIsNone(archive.error)
        self.assertTrue(self.replay.thread.is_alive())

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
