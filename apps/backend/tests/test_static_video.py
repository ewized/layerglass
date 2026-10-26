"""Native demo video seeks use bounded byte ranges without changing API/media policy."""
from http.client import HTTPConnection
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import app
from test_pwa import Registry


class StaticVideoTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.media = b'0123456789abcdef' * 4
        (root / 'demo.mp4').write_bytes(self.media)
        (root / 'module.js').write_text('export const demo = true;')
        self.static = patch.object(app, 'STATIC', root)
        self.static.start()
        self.addCleanup(self.static.stop)
        self.server = app.ViewerServer(('127.0.0.1', 0), registry=Registry())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def connection(self):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        self.addCleanup(connection.close)
        return connection

    def get(self, headers=None, method='GET', path='/static/demo.mp4'):
        connection = self.connection()
        connection.request(method, path, headers=headers or {})
        return connection.getresponse()

    def test_full_video_and_head_advertise_ranges_with_existing_freshness_and_security(self):
        for method in ('GET', 'HEAD'):
            with self.subTest(method=method):
                response = self.get(method=method)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader('Accept-Ranges'), 'bytes')
                self.assertEqual(response.getheader('Content-Type'), 'video/mp4')
                self.assertEqual(int(response.getheader('Content-Length')), len(self.media))
                self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                self.assertEqual(response.getheader('X-Content-Type-Options'), 'nosniff')
                self.assertIsNone(response.getheader('Access-Control-Allow-Origin'))
                self.assertEqual(response.read(), self.media if method == 'GET' else b'')

    def test_single_open_ended_suffix_and_clamped_ranges(self):
        for value, start, end in [('bytes=0-3', 0, 3), ('bytes=40-', 40, 63),
                                  ('bytes=-4', 60, 63), ('bytes=-999', 0, 63),
                                  ('bytes=50-999', 50, 63)]:
            with self.subTest(value=value):
                response = self.get({'Range': value})
                self.assertEqual(response.status, 206)
                self.assertEqual(response.getheader('Content-Range'), f'bytes {start}-{end}/64')
                self.assertEqual(int(response.getheader('Content-Length')), end - start + 1)
                self.assertEqual(response.read(), self.media[start:end + 1])

    def test_invalid_or_unsatisfiable_ranges_have_no_body(self):
        for value in ('bytes=64-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5',
                      'bytes=bad', 'bytes=' + '9' * 4500 + '-'):
            with self.subTest(value=value[:32]):
                response = self.get({'Range': value})
                self.assertEqual(response.status, 416)
                self.assertEqual(response.getheader('Content-Range'), 'bytes */64')
                self.assertEqual(response.read(), b'')

    def test_head_and_unmatched_if_range_return_complete_representation_metadata(self):
        head = self.get({'Range': 'bytes=0-3'}, method='HEAD')
        self.assertEqual(head.status, 200)
        self.assertEqual(head.getheader('Content-Length'), '64')
        self.assertEqual(head.read(), b'')
        response = self.get({'Range': 'bytes=0-3', 'If-Range': '"old-version"'})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), self.media)

    def test_partial_response_preserves_http_connection_for_next_request(self):
        connection = self.connection()
        connection.request('GET', '/static/demo.mp4', headers={'Range': 'bytes=10-13'})
        response = connection.getresponse()
        self.assertEqual(response.read(), self.media[10:14])
        connection.request('GET', '/static/demo.mp4', headers={'Range': 'bytes=20-23'})
        response = connection.getresponse()
        self.assertEqual(response.status, 206)
        self.assertEqual(response.read(), self.media[20:24])

    def test_other_static_assets_keep_their_existing_response(self):
        response = self.get({'Range': 'bytes=0-3'}, path='/static/module.js')
        self.assertEqual(response.status, 200)
        self.assertIsNone(response.getheader('Accept-Ranges'))
        self.assertEqual(response.read(), b'export const demo = true;')


if __name__ == '__main__':
    unittest.main()
