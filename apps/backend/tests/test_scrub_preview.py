from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app import ViewerServer
from replay import PreviewBusy, ReplayBuffer
from test_replay import CAMERA, JpegSource, Registry, Source


JPEG = b'\xff\xd8thumbnail\xff\xd9'


class ScrubPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = Source(self.root)
        self.source.publish([1, 2, 3])
        self.registry = Registry(self.source)
        # Deterministic recording: these tests explicitly collect new segments.
        self.replay = ReplayBuffer(self.registry, root=self.root / 'buffer', timeout=10)
        self.addCleanup(self.replay.close)
        self.token = self.replay.create(CAMERA)['session_id']

    def collect(self, numbers):
        self.source.publish(numbers)
        with self.replay.lock:
            self.replay._collect(self.replay.archives[CAMERA], self.source)

    def test_one_sheet_bundles_six_samples_and_reuses_them(self):
        self.collect(range(3, 19))
        with patch.object(self.replay, '_sprite', return_value=JPEG) as decode:
            self.assertEqual(self.replay.preview(self.token, 0, 6), JPEG)
            self.assertEqual(self.replay.preview(self.token, 0, 6), JPEG)
            self.assertEqual(decode.call_count, 1)
            sources = decode.call_args.args[0]
            self.assertEqual([offset for _, offset in sources], [0, 1, 0, 1, 0, 1])
            self.assertTrue(all(source.closed for source, _ in sources))
            self.assertEqual(len(self.replay.previews), 1)

    def test_partial_sheets_are_stable_when_more_footage_arrives(self):
        self.collect(range(3, 10))
        with patch.object(self.replay, '_sprite', return_value=JPEG) as decode:
            self.assertEqual(self.replay.preview(self.token, 0, 3), JPEG)
            self.collect(range(3, 19))
            self.assertEqual(self.replay.preview(self.token, 0, 3), JPEG)
            self.assertEqual(decode.call_count, 1)
            self.assertEqual(self.replay.preview(self.token, 0, 6), JPEG)
            self.assertEqual(decode.call_count, 2)

    def test_near_end_samples_leave_room_for_a_decoded_frame(self):
        with patch.object(self.replay, '_sprite', return_value=JPEG) as decode:
            self.assertEqual(self.replay.preview(self.token, 1.999), JPEG)
            self.assertLessEqual(decode.call_args.args[0][0][1], 1.9)

    def test_jpeg_gap_sprites_use_the_held_image_then_the_successor_and_trim_normally(self):
        self.replay.release(self.token)
        self.registry.source = source = JpegSource()
        with patch('replay.time.time', return_value=1000):
            token = self.replay.create(CAMERA)['session_id']
        source.publish(1030)
        self.replay._collect(self.replay.archives[CAMERA], source)
        decoded = []

        def decode(sources):
            decoded.append([(file.read(), offset) for file, offset in sources])
            return JPEG

        with patch.object(self.replay, '_sprite', side_effect=decode):
            self.assertEqual(self.replay.preview(token, 25, 2), JPEG)
            self.assertEqual(decoded[-1], [(b'jpeg-at-1000', 0), (b'jpeg-at-1030', 0)])
            self.replay.max_bytes = 1
            self.replay._prune()
            self.assertFalse(self.replay.previews)
            self.assertIsNone(self.replay.preview(token, 25))
            self.assertEqual(self.replay.preview(token, 30), JPEG)
            self.assertEqual(decoded[-1], [(b'jpeg-at-1030', 0)])
            self.assertIsNone(self.replay.preview(token, 31))

    def test_jpeg_subsecond_successor_replaces_a_cached_provisional_tail_sample(self):
        self.replay.release(self.token)
        self.registry.source = source = JpegSource()
        with patch('replay.time.time', return_value=1000):
            token = self.replay.create(CAMERA)['session_id']
        with patch.object(self.replay, '_sprite', return_value=JPEG) as decode:
            self.assertEqual(self.replay.preview(token, 0.75), JPEG)
            source.publish(1000.5)
            self.replay._collect(self.replay.archives[CAMERA], source)
            self.assertEqual(self.replay.preview(token, 0.75), JPEG)
            self.assertEqual(decode.call_count, 2)
            self.assertEqual([item.start for item in self.replay.archives[CAMERA].fragments], [0, 0.5])

    def test_later_pages_cannot_preview_earlier_pages_history(self):
        self.collect(range(3, 7))
        other = self.replay.create(CAMERA)['session_id']
        with patch.object(self.replay, '_sprite', return_value=JPEG):
            self.assertIsNone(self.replay.preview(other, 0))
            self.assertIsNone(self.replay.preview(other, -2))
            self.collect(range(3, 8))
            self.assertEqual(self.replay.preview(other, 0), JPEG)
            self.assertEqual(self.replay.preview(self.token, 0), JPEG)
            self.assertEqual(len(self.replay.previews), 2)

    def test_unavailable_or_invalid_positions_do_not_start_a_decoder(self):
        with patch.object(self.replay, '_sprite') as decode:
            for token, at in [(self.token, -1), (self.token, float('nan')),
                              (self.token, float('inf')), (self.token, 2), ('f' * 32, 0)]:
                self.assertIsNone(self.replay.preview(token, at))
            for frames in (0, -1, 7, 1.5, True):
                self.assertIsNone(self.replay.preview(self.token, 0, frames))
            self.assertIsNone(self.replay.preview(self.token, 0, 2), 'A sheet must not claim unavailable future cells.')
            decode.assert_not_called()

    def test_trimming_and_releasing_remove_cached_footage(self):
        with patch.object(self.replay, '_sprite', return_value=JPEG):
            self.replay.preview(self.token, 0)
            self.collect(range(3, 8))
            self.replay.max_bytes = 1
            with self.replay.lock:
                self.replay._prune()
            self.assertEqual(len(self.replay.previews), 0)
            self.assertIsNone(self.replay.preview(self.token, 0))
            self.replay.preview(self.token, self.replay.status(self.token)['start_seconds'])
            self.assertEqual(len(self.replay.previews), 1)
            self.replay.release(self.token)
            self.assertEqual(len(self.replay.previews), 0)
            self.assertIsNone(self.replay.preview(self.token, 0))

    def test_preview_cache_is_bounded_and_retains_recently_used_frames(self):
        self.collect(range(3, 150))
        with patch.object(self.replay, '_sprite', return_value=JPEG) as decode:
            for position in range(134):
                self.replay.preview(self.token, position)
            self.assertEqual(len(self.replay.previews), 128)
            self.replay.preview(self.token, 133)
            self.assertEqual(decode.call_count, 134)
            self.replay.preview(self.token, 0)
            self.assertEqual(decode.call_count, 135, 'Old entries must be evicted.')

    def test_encoded_sheets_have_a_shared_memory_bound(self):
        self.collect(range(3, 150))
        with patch.object(self.replay, '_sprite', return_value=JPEG + bytes(256 * 1024)):
            for position in range(100):
                self.replay.preview(self.token, position)
            self.assertLessEqual(sum(map(len, self.replay.previews.values())), 16 * 1024 * 1024)
            self.assertGreater(len(self.replay.previews), 32)

    def test_five_minute_windows_survive_scrubbing_into_another_window(self):
        self.collect(range(3, 320))
        with patch.object(self.replay, '_sprite', return_value=JPEG + bytes(256 * 1024)) as decode:
            for position in range(0, 600, 30):
                self.assertIsNotNone(self.replay.preview(self.token, position, 6))
            self.assertEqual(decode.call_count, 20)
            for position in range(0, 300, 30):
                self.assertIsNotNone(self.replay.preview(self.token, position, 6))
            self.assertEqual(decode.call_count, 20, 'Revisiting five minutes of previews should not decode them again.')

    def test_decoding_does_not_block_recording_and_duplicate_work_is_shared(self):
        entered = threading.Event()
        finish = threading.Event()

        def decode(sources):
            entered.set()
            self.assertTrue(finish.wait(3))
            return JPEG

        with patch.object(self.replay, '_sprite', side_effect=decode) as decoder:
            with ThreadPoolExecutor(max_workers=2) as workers:
                first = workers.submit(self.replay.preview, self.token, 0)
                self.assertTrue(entered.wait(1))
                duplicate = workers.submit(self.replay.preview, self.token, 0)
                # These both acquire the recorder lock while a decode is running.
                self.collect(range(3, 6))
                self.assertEqual(self.replay.status(self.token)['end_seconds'], 6)
                finish.set()
                self.assertEqual(first.result(3), JPEG)
                self.assertEqual(duplicate.result(3), JPEG)
            self.assertEqual(decoder.call_count, 1)

    def test_only_two_decoders_can_run_and_forgotten_jobs_cannot_restore_cache(self):
        self.collect(range(3, 6))
        finish = threading.Event()
        entered = threading.Barrier(3)

        def decode(sources):
            entered.wait(2)
            self.assertTrue(finish.wait(3))
            return JPEG

        with patch.object(self.replay, '_sprite', side_effect=decode):
            with ThreadPoolExecutor(max_workers=2) as workers:
                jobs = [workers.submit(self.replay.preview, self.token, position) for position in (0, 2)]
                entered.wait(2)
                try:
                    with self.assertRaises(PreviewBusy):
                        self.replay.preview(self.token, 4)
                    self.replay.forget(CAMERA)
                finally:
                    finish.set()
                self.assertEqual([job.result(3) for job in jobs], [None, None])
        self.assertFalse(self.replay.previews)
        self.assertFalse(self.replay.preview_jobs)

    def test_http_validates_positions_and_never_caches_footage(self):
        server = ViewerServer(('127.0.0.1', 0), registry=self.registry, replay=self.replay)
        self.addCleanup(server.server_close)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_port}/replay/{self.token}/preview.jpg'
        self.collect(range(3, 19))
        with patch.object(self.replay, '_sprite', return_value=JPEG) as decode:
            for query in ('', '?at=nan', '?at=inf', '?at=-1', '?at=1e50', '?at=no',
                          '?at=0&frames=0', '?at=0&frames=7', '?at=0&frames=1.5', '?at=0&frames=bad'):
                with self.assertRaises(HTTPError) as failure:
                    urlopen(base + query, timeout=2)
                self.assertEqual(failure.exception.code, 400)
            with self.assertRaises(HTTPError) as failure:
                urlopen(Request(base + '?at=0', method='HEAD'), timeout=2)
            self.assertEqual(failure.exception.code, 405)
            decode.assert_not_called()
            with urlopen(base + '?at=0&frames=6', timeout=2) as response:
                self.assertEqual(response.headers['Content-Type'], 'image/jpeg')
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
                self.assertNotIn('X-App-Shell-Revision', response.headers)
                self.assertEqual(response.read(), JPEG)
            with self.assertRaises(HTTPError) as failure:
                urlopen(base + '?at=999', timeout=2)
            self.assertEqual(failure.exception.code, 404)
        with patch.object(self.replay, 'preview', side_effect=PreviewBusy):
            with self.assertRaises(HTTPError) as failure:
                urlopen(base + '?at=0', timeout=2)
            self.assertEqual(failure.exception.code, 503)

    def test_real_sheet_has_six_correct_frames_and_preserves_crop_order(self):
        clip = self.root / 'colors.ts'
        colors = ('red', 'blue', 'lime', 'yellow', 'magenta', 'cyan')
        inputs = [arg for color in colors for arg in ('-f', 'lavfi', '-i', f'color=c={color}:s=640x360:r=10:d=5')]
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-filter_complex_threads', '1', *inputs,
                        '-filter_complex', '[0:v][1:v][2:v][3:v][4:v][5:v]concat=n=6:v=1:a=0',
                        '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '10',
                        '-color_range', 'tv',
                        '-f', 'mpegts', str(clip)], check=True, timeout=10)
        sources = [(clip.open('rb'), index * 5) for index in range(6)]
        try:
            sheet = self.replay._sprite(sources)
        finally:
            for source, _ in sources:
                source.close()
        self.assertIsNotNone(sheet)
        self.assertTrue(sheet.startswith(b'\xff\xd8'))
        probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height',
                                '-of', 'json', 'pipe:0'], input=sheet, capture_output=True, check=True, timeout=5)
        self.assertEqual(json.loads(probe.stdout)['streams'][0], {'width': 960, 'height': 360})
        pixels = subprocess.run(['ffmpeg', '-v', 'error', '-threads', '1', '-filter_threads', '1',
                                '-i', 'pipe:0', '-vf', 'scale=3:2:flags=neighbor', '-frames:v', '1', '-threads', '1',
                                '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
                               input=sheet, capture_output=True, check=True, timeout=5).stdout
        expected = ((255, 0, 0), (0, 0, 255), (0, 255, 0), (255, 255, 0), (255, 0, 255), (0, 255, 255))
        for index, color in enumerate(expected):
            for channel, value in enumerate(color):
                self.assertLess(abs(pixels[index * 3 + channel] - value), 25, f'Wrong cell at {index * 5} seconds.')
        jpeg = self.root / 'frame.jpg'
        jpeg.write_bytes(sheet)
        with jpeg.open('rb') as source:
            jpeg.unlink()
            self.assertTrue(self.replay._sprite([(source, 0)]).startswith(b'\xff\xd8'), 'Open sources survive trimming.')

    def test_invalid_media_and_decoder_timeout_fail_quietly(self):
        with self.replay.media(self.token, sequence=0).open('rb') as source:
            self.assertIsNone(self.replay._sprite([(source, 0)]))
        with patch('replay.subprocess.run', side_effect=subprocess.TimeoutExpired('ffmpeg', 5)):
            self.assertIsNone(self.replay.preview(self.token, 0))
            self.assertFalse(self.replay.previews)
            self.assertFalse(self.replay.preview_jobs)
        with patch.object(self.replay, '_sprite', return_value=JPEG):
            self.assertEqual(self.replay.preview(self.token, 0), JPEG, 'A timeout must release the worker slot.')

    def test_short_single_keyframe_segments_with_absolute_timestamps(self):
        clip = self.root / 'recorded.ts'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-filter_complex_threads', '1',
                        '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=15:d=1',
                        '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=15:d=1',
                        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
                        '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '30',
                        '-sc_threshold', '0', '-color_range', 'tv', '-output_ts_offset', '17',
                        '-f', 'mpegts', str(clip)], check=True, timeout=10)
        with clip.open('rb') as first, clip.open('rb') as second:
            sheet = self.replay._sprite([(first, 0), (second, 1)])
        self.assertIsNotNone(sheet, 'Short segments must decode even when no later keyframe exists.')
        pixels = subprocess.run(['ffmpeg', '-v', 'error', '-threads', '1', '-filter_threads', '1',
                                 '-i', 'pipe:0', '-vf', 'scale=3:2:flags=neighbor', '-frames:v', '1',
                                 '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
                                input=sheet, capture_output=True, check=True, timeout=5).stdout
        self.assertGreater(pixels[0], pixels[2] + 100)
        self.assertGreater(pixels[5], pixels[3] + 100)
