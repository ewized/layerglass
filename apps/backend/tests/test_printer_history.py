from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

from app import ViewerServer
from replay import ReplayBuffer
from test_replay import CAMERA, JpegSource, Registry, Source


class Telemetry:
    values = None

    def status(self):
        return dict(self.values)


class PrinterHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = Source(self.root)
        self.telemetry = Telemetry()
        self.telemetry.values = {'connection': 'connected', 'progress': 10, 'layer': 4,
                                 'remaining_minutes': 90, 'nozzle': 210, 'bed': 60,
                                 'access_code': 'private-never-record', 'raw': {'private': 'never-record'}}
        self.registry = Registry(self.source)
        self.registry.get_telemetry = lambda key: self.telemetry if key == CAMERA else None
        self.replay = ReplayBuffer(self.registry, root=self.root / 'buffer', timeout=10)
        self.addCleanup(self.replay.close)
        self.publish([1, 2, 3], 96)
        with patch('replay.time.time', return_value=100):
            self.session = self.replay.create(CAMERA)
        self.token = self.session['session_id']

    def publish(self, numbers, epoch):
        self.source.publish(numbers)
        path = self.source.directory / 'live.m3u8'
        lines = []
        index = 0
        for line in path.read_text().splitlines():
            if line.startswith('segment-'):
                date = datetime.fromtimestamp(epoch + index * 2, timezone.utc).isoformat()
                lines.append('#EXT-X-PROGRAM-DATE-TIME:' + date)
                index += 1
            lines.append(line)
        path.write_text('\n'.join(lines) + '\n')

    def sample(self, at, **values):
        self.telemetry.values.update(values)
        with patch('replay.time.time', return_value=at):
            self.replay._collect_printer(self.replay.archives[CAMERA], force=True)

    def test_readings_are_immutable_allowlisted_history_instead_of_current_values(self):
        self.sample(102, progress=20, layer=8, remaining_minutes=80, nozzle=220)
        self.sample(104, progress=30, layer=12, remaining_minutes=70)
        history = self.replay.printer_history(self.token, 101)
        samples = history['samples']
        self.assertEqual([sample['at'] for sample in samples], [100, 102, 104])
        self.assertEqual([sample['printer']['progress'] for sample in samples], [10, 20, 30])
        self.assertNotIn('private', json.dumps(history))
        self.assertNotIn('raw', json.dumps(history))
        samples[0]['printer']['progress'] = 999
        self.assertEqual(self.replay.printer_history(self.token, 101)['samples'][0]['printer']['progress'], 10)

    def test_both_nozzles_elapsed_and_additional_readings_are_immutable_history(self):
        self.sample(102, nozzle_count=2, nozzle_1=210, nozzle_1_target=215, nozzle_2=46, nozzle_2_target=25,
                    active_nozzle=1, elapsed_seconds=100, elapsed_source='printer', chamber=34,
                    chamber_target=0, speed_mode='Standard', speed_percent=100, aux_fan=0, part_fan=100)
        self.sample(104, nozzle_2=47, active_nozzle=2, elapsed_seconds=102, chamber=35)
        samples = self.replay.printer_history(self.token, 102)['samples']
        first, second = samples[-2]['printer'], samples[-1]['printer']
        self.assertEqual((first['nozzle_2'], first['elapsed_seconds'], first['active_nozzle']), (46, 100, 1))
        self.assertEqual((second['nozzle_2'], second['elapsed_seconds'], second['active_nozzle']), (47, 102, 2))
        self.assertEqual((second['nozzle_1_target'], second['chamber_target'], second['aux_fan']), (215, 0, 0))
        self.assertEqual((second['speed_mode'], second['part_fan'], second['elapsed_source']), ('Standard', 100, 'printer'))

    def test_nested_native_and_new_adapter_fields_follow_recorded_time(self):
        self.sample(102, reported={'print': {'new_sensor': {'ready': False}, 'ams': [{'id': '0', 'humidity': 4}]}}, future_field=0)
        self.sample(104, reported={'print': {'new_sensor': {'ready': True}, 'ams': [{'id': '0', 'humidity': 5}]}})
        history = self.replay.printer_history(self.token, 102)['samples']
        self.assertEqual(history[-2]['printer']['reported']['print']['ams'][0]['humidity'], 4)
        self.assertEqual(history[-2]['printer']['future_field'], 0)
        self.assertFalse(history[-2]['printer']['reported']['print']['new_sensor']['ready'])
        self.telemetry.values['reported']['print']['ams'][0]['humidity'] = 99
        history[-2]['printer']['reported']['print']['ams'][0]['humidity'] = 999
        self.assertEqual(self.replay.printer_history(self.token, 102)['samples'][-2]['printer']['reported']['print']['ams'][0]['humidity'], 4)

    def test_large_metadata_is_compressed_and_pruned_by_its_byte_budget(self):
        self.sample(102, reported={'print': {f'sensor_{i}': 'repeated-value' for i in range(400)}})
        archive = self.replay.archives[CAMERA]
        self.assertIsInstance(archive.printer_samples[-1]['printer'], bytes)
        self.assertLess(len(archive.printer_samples[-1]['printer']), 3000)
        self.replay.PRINTER_BYTE_LIMIT = 4000
        for at in range(103, 120):
            self.sample(at, layer=at)
        self.assertLessEqual(archive.printer_bytes, 4000)
        self.assertGreater(self.replay.printer_history(self.token, 102)['samples'][0]['at'], 102)

    def test_video_clock_uses_program_dates_and_preserves_reconnect_gaps(self):
        self.assertEqual(self.session['clock'], [{'position': 0, 'time': 100}])
        self.publish([3, 4], 100)
        self.replay._collect(self.replay.archives[CAMERA], self.source)
        self.assertEqual(self.replay.status(self.token)['clock'], [{'position': 0, 'time': 100}])
        self.source.generation = 'b' * 32
        self.source.directory = self.root / self.source.generation
        self.source.directory.mkdir()
        self.publish([1], 200)
        self.replay._collect(self.replay.archives[CAMERA], self.source)
        self.assertEqual(self.replay.status(self.token)['clock'],
                         [{'position': 0, 'time': 100}, {'position': 4, 'time': 200}])

    def test_jpeg_gap_http_frames_and_recorded_readings_share_a_forward_clock(self):
        self.replay.release(self.token)
        self.registry.source = source = JpegSource()
        self.telemetry.values = {'layer': 0}
        with patch('replay.time.time', return_value=1000):
            token = self.replay.create(CAMERA)['session_id']
        archive = self.replay.archives[CAMERA]
        for epoch in range(1001, 1066):
            self.telemetry.values = {'layer': epoch - 1000}
            with patch('replay.time.time', return_value=epoch), self.replay.lock:
                self.replay._collect_printer(archive, force=True)
                if epoch >= 1030:
                    source.publish(epoch)
                    self.replay._collect(archive, source)
        server = ViewerServer(('127.0.0.1', 0), registry=self.registry, replay=self.replay)
        self.addCleanup(server.server_close)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_port}'
        with urlopen(f'{base}/api/sessions/{token}', timeout=3) as response:
            metadata = json.load(response)
        with urlopen(f'{base}/api/sessions/{token}/printer?at=1030', timeout=3) as response:
            samples = json.load(response)['samples']
        self.assertEqual(metadata['clock'], [{'position': 0, 'time': 1000}])
        for position, expected_image, expected_layer in ((29.5, 1000, 29), (30.5, 1030, 30), (31.1, 1031, 31)):
            with self.subTest(position=position):
                with urlopen(f'{base}/replay/{token}/frame.jpg?at={position}', timeout=3) as response:
                    self.assertEqual(response.read(), f'jpeg-at-{expected_image}'.encode())
                clock = min(1000 + position, metadata['end_time'])
                selected = next(sample for sample in reversed(samples) if sample['at'] <= clock)
                self.assertEqual(selected['printer']['layer'], expected_layer)

    def test_jpeg_waiting_page_never_receives_pre_open_printer_samples(self):
        self.replay.release(self.token)
        self.registry.source = source = JpegSource()
        with patch('replay.time.time', return_value=1000):
            earlier = self.replay.create(CAMERA)['session_id']
        self.sample(1010, layer=10)
        with patch('replay.time.time', return_value=1020):
            later = self.replay.create(CAMERA)['session_id']
        self.replay.release(earlier)
        self.sample(1030, layer=30)
        source.publish(1030)
        self.replay._collect(self.replay.archives[CAMERA], source)
        self.replay._prune()
        metadata = self.replay.status(later)
        self.assertEqual(metadata['start_seconds'], 10)
        self.assertEqual(metadata['clock'], [{'position': -20, 'time': 1000}])
        for payload in (self.replay.printer_history(later, 1010), self.replay.printer_updates(later)):
            self.assertTrue(payload['samples'])
            self.assertTrue(all(sample['at'] >= 1020 for sample in payload['samples']))
        self.assertIsNone(self.replay.media(later, sequence=0))

    def test_sse_updates_send_a_small_initial_window_then_only_new_samples_and_baseline(self):
        for at in range(101, 160):
            self.sample(at, progress=at % 100)
        initial = self.replay.printer_updates(self.token)
        self.assertEqual(len(initial['samples']), 32)
        cursor = initial['cursor']
        self.sample(160, progress=60)
        delta = self.replay.printer_updates(self.token, cursor)
        self.assertEqual([sample['at'] for sample in delta['samples']], [159, 160])
        self.assertEqual(delta['cursor'], cursor + 1)

    def test_later_tabs_do_not_receive_older_readings_and_release_forgets_history(self):
        self.sample(102, progress=20)
        with patch('replay.time.time', return_value=104):
            later = self.replay.create(CAMERA)['session_id']
        self.sample(106, progress=30)
        for payload in (self.replay.printer_history(later, 101), self.replay.printer_updates(later)):
            self.assertTrue(all(sample['at'] >= 104 for sample in payload['samples']))
        self.assertTrue(any(sample['at'] == 100 for sample in self.replay.printer_history(self.token, 101)['samples']))
        self.replay.release(self.token)
        self.replay.release(later)
        self.assertEqual(self.replay.archives, {})
        self.assertIsNone(self.replay.printer_history(self.token, 101))

    def test_history_prunes_with_video_and_has_an_independent_memory_bound(self):
        for at in range(101, 113):
            self.sample(at, progress=at % 100)
        self.publish(range(3, 9), 100)
        self.replay._collect(self.replay.archives[CAMERA], self.source)
        self.replay.max_bytes = 25
        self.replay._prune()
        history = self.replay.printer_history(self.token, 101)
        self.assertGreater(history['samples'][0]['at'], 100)
        self.replay.PRINTER_LIMIT = 3
        for at in range(113, 120):
            self.sample(at)
        self.assertEqual(len(self.replay.archives[CAMERA].printer_samples), 3)

    def test_http_history_is_private_uncached_and_rejects_invalid_time_or_expired_sessions(self):
        server = ViewerServer(('127.0.0.1', 0), registry=self.registry, replay=self.replay)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_port}/api/sessions/'
        with urlopen(f'{base}{self.token}/printer?at=101', timeout=3) as response:
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertNotIn('X-App-Shell-Revision', response.headers)
            self.assertEqual(json.load(response)['session_id'], self.token)
        for suffix in ('', '?at=nan', '?at=inf', '?at=-1', '?at=9007199254740992'):
            with self.assertRaises(HTTPError) as error:
                urlopen(f'{base}{self.token}/printer{suffix}', timeout=3)
            self.assertEqual(error.exception.code, 400)
        self.replay.release(self.token)
        with self.assertRaises(HTTPError) as error:
            urlopen(f'{base}{self.token}/printer?at=101', timeout=3)
        self.assertEqual(error.exception.code, 404)


if __name__ == '__main__':
    unittest.main()
