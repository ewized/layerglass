import http.client
import json
from pathlib import Path
import socket
import struct
import tempfile
import threading
import time
import unittest

from app import ViewerServer
from replay import ReplayBuffer
from test_replay import CAMERA, Registry, Source


class VideoStreamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Source(Path(self.temp.name))
        self.source.publish([1, 2, 3])
        self.registry = Registry(self.source)
        self.replay = ReplayBuffer(self.registry, root=Path(self.temp.name) / 'buffer', timeout=10)
        self.replay.start()
        self.addCleanup(self.replay.close)
        self.server = ViewerServer(('127.0.0.1', 0), registry=self.registry, replay=self.replay)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.token = self.replay.create(CAMERA)['session_id']

    def publish(self, numbers):
        self.source.publish(numbers)
        with self.replay.lock:
            self.replay._collect(self.replay.archives[CAMERA], self.source)

    def connect(self, suffix='', token=None, headers=None, method='GET'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        connection.request(method, f'/replay/{token or self.token}/video{suffix}', headers=headers or {})
        response = connection.getresponse()
        if response.status != 200:
            response.read()
        self.addCleanup(response.close)
        self.addCleanup(connection.close)
        return response

    def record(self, response):
        header_size, body_size = struct.unpack('!II', response.read(8))
        return json.loads(response.read(header_size)), response.read(body_size)

    def test_one_http_response_pushes_successive_original_video_fragments(self):
        response = self.connect()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader('Content-Type'), 'application/octet-stream')
        self.assertEqual(response.getheader('X-Accel-Buffering'), 'no')
        self.assertEqual(response.getheader('Cache-Control'), 'no-store, no-transform')
        self.assertIsNone(response.getheader('Content-Length'))
        self.assertEqual(response.read(4), b'BCV1')
        index, data = self.record(response)
        self.assertEqual(index['type'], 'index')
        self.assertEqual([item['sequence'] for item in index['segments']], [0])
        self.assertEqual(data, b'')
        header, data = self.record(response)
        self.assertEqual(header, {'type': 'segment', 'sequence': 0})
        self.assertEqual(data, b'frame-a-3')
        self.publish([3, 4])
        index, _ = self.record(response)
        self.assertEqual(index['type'], 'update')
        self.assertEqual([item['sequence'] for item in index['segments']], [1])
        header, data = self.record(response)
        self.assertEqual(header['sequence'], 1)
        self.assertEqual(data, b'frame-a-4')

    def test_rewind_starts_at_requested_segment_and_reconnect_does_not_reset_history(self):
        self.publish(range(3, 20))
        response = self.connect('?start=1')
        response.read(4)
        index, _ = self.record(response)
        self.assertEqual(index['start'], 0)
        header, data = self.record(response)
        self.assertEqual(header['sequence'], 1)
        self.assertEqual(data, b'frame-a-4')
        metadata = self.replay.status(self.token)
        response.close()
        again = self.connect()
        again.read(4)
        index, _ = self.record(again)
        header, _ = self.record(again)
        self.assertEqual(header['sequence'], index['last'] - 5)
        self.assertEqual(metadata, self.replay.status(self.token))

    def test_later_pages_cannot_stream_history_from_an_earlier_page(self):
        self.publish([3, 4, 5])
        later = self.replay.create(CAMERA)['session_id']
        self.publish([4, 5, 6])
        response = self.connect('?start=0', token=later)
        response.read(4)
        index, _ = self.record(response)
        self.assertEqual(index['first'], 3)
        self.assertEqual([item['sequence'] for item in index['segments']], [3])
        header, data = self.record(response)
        self.assertEqual(header['sequence'], 3)
        self.assertEqual(data, b'frame-a-6')

    def test_stream_ends_when_page_session_is_released(self):
        response = self.connect()
        response.read(4)
        self.record(response)
        self.record(response)
        self.replay.release(self.token)
        self.assertEqual(response.read(1), b'')
        self.assertIsNone(self.replay.status(self.token))

    def test_stream_index_reports_storage_trimming_and_timestamp_discontinuity(self):
        self.replay.max_bytes = 25
        self.publish(range(3, 10))
        with self.replay.lock:
            self.replay._prune()
        with self.source.lock:
            self.source.generation = 'b' * 32
            self.source.directory = Path(self.temp.name) / self.source.generation
            self.source.directory.mkdir()
        self.publish([1])
        update, _ = self.replay.video_update(self.token, after=0)
        self.assertGreater(update['start'], 0)
        self.assertTrue(update['segments'][-1]['discontinuity'])
        self.assertEqual(update['segments'][-1]['discontinuities'], 1)

    def test_expired_cross_origin_invalid_positions_and_head_requests(self):
        self.assertEqual(self.connect(token='c' * 32).status, 404)
        self.assertEqual(self.connect(headers={'Origin': 'https://other.example'}).status, 403)
        for query in ['?start=-1', '?start=nope', '?start=9007199254740992']:
            self.assertEqual(self.connect(query).status, 400)
        response = self.connect(method='HEAD')
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), b'')

    def test_archived_video_has_a_small_initial_burst_then_is_paced(self):
        self.publish(range(3, 30))
        response = self.connect('?start=0')
        response.read(4)
        self.record(response)
        began = time.monotonic()
        for _ in range(7):
            header, _ = self.record(response)
            self.assertEqual(header['type'], 'segment')
        self.assertLess(time.monotonic() - began, 2)
        response.fp.raw._sock.settimeout(0.2)
        with self.assertRaises((TimeoutError, socket.timeout)):
            response.read(8)


if __name__ == '__main__':
    unittest.main()
