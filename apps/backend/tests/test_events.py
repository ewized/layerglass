"""Exercise streamed updates over real HTTP sockets, without a printer."""

from copy import deepcopy
from http.client import HTTPConnection
import json
import select
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app import ViewerServer


CAMERA = '1' * 16
OTHER = '2' * 16
TOKEN = 'a' * 32


class Registry:
    def __init__(self):
        self.source = 'rtsps://fixture:never-stream-this-secret@192.168.50.2/live'
        self.data = {'cameras': [{'id': CAMERA, 'configured': True}],
                     'default_camera_id': CAMERA, 'discovery': {'state': 'done', 'checked': 10}}
        self.state = 'live'
        self.generation = 'b' * 32
        self.clock = 0

    def catalog(self):
        return deepcopy(self.data)

    def status(self, camera=None):
        self.clock += 1
        return {'camera_id': camera or CAMERA, 'state': self.state, 'generation': self.generation,
                'message': 'Camera connected.', 'playlist_url': '/stream/fixture/live.m3u8',
                'uptime_seconds': self.clock, 'last_segment_age_seconds': self.clock / 10}

    def healthy(self):
        return True


class Replay:
    def __init__(self):
        self.data = {'session_id': TOKEN, 'camera_id': CAMERA, 'end_seconds': 2, 'ready': True}
        self.touches = 0
        self.thread = threading.current_thread()

    def status(self, token):
        self.touches += 1
        return deepcopy(self.data) if token == TOKEN else None


class EventsTests(unittest.TestCase):
    def setUp(self):
        self.registry = Registry()
        self.replay = Replay()
        self.server = ViewerServer(('127.0.0.1', 0), registry=self.registry, replay=self.replay)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def stream(self, query=''):
        response = urlopen(self.base + '/api/events' + query, timeout=3)
        self.addCleanup(response.close)
        return response

    @staticmethod
    def event(response):
        kind = None
        data = None
        while True:
            line = response.readline()
            if not line:
                raise AssertionError('The event stream closed unexpectedly.')
            if line.startswith(b'event: '):
                kind = line[7:].strip().decode()
            elif line.startswith(b'data: '):
                data = json.loads(line[6:])
            elif line == b'\n' and kind:
                return kind, data

    def test_initial_state_headers_and_private_fields(self):
        response = self.stream(f'?camera={CAMERA}&session={TOKEN}')
        self.assertEqual(response.headers['Content-Type'], 'text/event-stream; charset=utf-8')
        self.assertIsNone(response.headers['Content-Length'])
        self.assertEqual(response.headers['Connection'], 'close')
        self.assertEqual(response.headers['X-Accel-Buffering'], 'no')
        self.assertIn('no-transform', response.headers['Cache-Control'])
        kind, state = self.event(response)
        self.assertEqual(kind, 'state')
        self.assertEqual(state['status']['camera_id'], CAMERA)
        self.assertEqual(state['session_id'], TOKEN)
        self.assertEqual(state['replay']['end_seconds'], 2)
        self.assertEqual(state['catalog'], self.registry.data)
        self.assertNotIn('never-stream-this-secret', json.dumps(state))
        self.assertNotIn('rtsps://', json.dumps(state))

    def test_unchanged_data_and_volatile_clocks_do_not_emit_redundant_events(self):
        response = self.stream(f'?camera={CAMERA}&session={TOKEN}')
        self.event(response)
        readable, _, _ = select.select([response.fp.raw._sock], [], [], 1.2)
        self.assertEqual(readable, [], 'Unchanged metadata must not send repeated state events.')
        self.assertGreaterEqual(self.replay.touches, 3, 'The open stream must maintain its replay lease.')
        self.replay.data['end_seconds'] = 4
        kind, state = self.event(response)
        self.assertEqual(kind, 'state')
        self.assertEqual(set(state), {'version', 'session_id', 'replay'})
        self.assertEqual(state['replay']['end_seconds'], 4)

    def test_scan_progress_and_status_changes_arrive_without_more_requests(self):
        response = self.stream(f'?camera={CAMERA}')
        self.event(response)
        self.registry.data['discovery'] = {'state': 'scanning', 'checked': 5}
        self.registry.state = 'reconnecting'
        _, state = self.event(response)
        self.assertEqual(state['catalog']['discovery']['state'], 'scanning')
        self.assertEqual(state['status']['state'], 'reconnecting')
        self.registry.data['discovery'] = {'state': 'done', 'checked': 10}
        _, state = self.event(response)
        self.assertEqual(state['catalog']['discovery']['state'], 'done')

    def test_reconnect_starts_with_a_fresh_full_snapshot(self):
        response = self.stream(f'?camera={CAMERA}&session={TOKEN}')
        self.event(response)
        response.close()
        self.replay.data['end_seconds'] = 12
        self.registry.generation = 'c' * 32
        replacement = self.stream(f'?camera={CAMERA}&session={TOKEN}')
        _, state = self.event(replacement)
        self.assertEqual(state['replay']['end_seconds'], 12)
        self.assertEqual(state['status']['generation'], 'c' * 32)
        self.assertIn('catalog', state)

    def test_expired_session_is_reported_and_other_camera_session_is_isolated(self):
        response = self.stream(f'?camera={CAMERA}&session={TOKEN}')
        self.event(response)
        self.replay.data = None
        _, state = self.event(response)
        self.assertIsNone(state['replay'])
        self.replay.data = {'session_id': TOKEN, 'camera_id': OTHER, 'end_seconds': 100}
        other = self.stream(f'?camera={CAMERA}&session={TOKEN}')
        _, state = self.event(other)
        self.assertIsNone(state['replay'])

    def test_validation_cross_origin_and_head(self):
        for route in ['/api/events', '/api/snapshot']:
            for suffix in ['?camera=invalid', '?session=invalid']:
                with self.subTest(route=route, suffix=suffix), self.assertRaises(HTTPError) as error:
                    urlopen(self.base + route + suffix, timeout=3)
                self.assertEqual(error.exception.code, 400)
            with self.subTest(route=route), self.assertRaises(HTTPError) as error:
                urlopen(Request(self.base + route, headers={'Origin': 'https://other.example'}), timeout=3)
            self.assertEqual(error.exception.code, 403)
        with urlopen(Request(self.base + '/api/events', method='HEAD'), timeout=3) as response:
            self.assertEqual(response.read(), b'')

    def test_fallback_snapshot_and_http_connection_reuse(self):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        self.addCleanup(connection.close)
        connection.request('GET', f'/api/snapshot?camera={CAMERA}&session={TOKEN}')
        response = connection.getresponse()
        self.assertEqual(response.version, 11)
        state = json.loads(response.read())
        self.assertEqual(state['replay']['end_seconds'], 2)
        socket = connection.sock
        connection.request('GET', '/healthz')
        self.assertEqual(json.loads(connection.getresponse().read()), {'ok': True})
        self.assertIs(connection.sock, socket, 'Short HTTP responses must reuse the connection.')

    def test_server_shutdown_closes_active_stream(self):
        response = self.stream(f'?camera={CAMERA}')
        self.event(response)
        self.server.server_close()
        self.assertEqual(response.read(1), b'')


if __name__ == '__main__':
    unittest.main()
