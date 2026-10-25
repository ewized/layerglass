"""Cast receivers can read HLS, without opening cross-origin API access."""

from pathlib import Path
from types import SimpleNamespace
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import app


TOKEN = 'a' * 32
CAMERA = 'b' * 16


class CastMediaTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        segment = root / 'segment.ts'
        segment.write_bytes(b'fixture video')
        playlist = b'#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment-0.ts\n'
        for folder in (root / TOKEN, root / CAMERA / TOKEN):
            folder.mkdir(parents=True)
            (folder / 'live.m3u8').write_bytes(playlist)
            (folder / 'segment-0.ts').write_bytes(segment.read_bytes())
        registry = SimpleNamespace(settings=SimpleNamespace(stream_root=root),
            status=lambda camera=None: {'state': 'empty'}, catalog=lambda: {'cameras': []})
        replay = SimpleNamespace(playlist=lambda token: playlist if token == TOKEN else None,
            media=lambda token, **kwargs: segment if token == TOKEN else None,
            status=lambda token: None)
        self.server = app.ViewerServer(('127.0.0.1', 0), registry=registry, replay=replay)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, method='GET', **headers):
        request = Request(self.base + path, method=method,
            headers={'Origin': 'https://www.gstatic.com', **headers})
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as response:
            self.addCleanup(response.close)
            return response
        self.addCleanup(response.close)
        return response

    def test_cast_playlist_and_segments_support_get_and_head(self):
        for prefix in (f'/replay/{TOKEN}', f'/stream/{CAMERA}/{TOKEN}'):
            for name in ('live.m3u8', 'segment-0.ts'):
                for method in ('GET', 'HEAD'):
                    with self.subTest(prefix=prefix, name=name, method=method):
                        response = self.request(f'{prefix}/{name}?viewer=fixture', method)
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.headers['Access-Control-Allow-Origin'], '*')
                        self.assertEqual(response.headers['Cache-Control'], 'no-store')
                        self.assertNotIn('Access-Control-Allow-Credentials', response.headers)

    def test_read_only_preflight_and_private_network_cast(self):
        response = self.request(f'/replay/{TOKEN}/segment-0.ts', 'OPTIONS',
            **{'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range',
               'Access-Control-Request-Private-Network': 'true'})
        self.assertEqual(response.status, 204)
        self.assertEqual(response.read(), b'')
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], '*')
        self.assertEqual(response.headers['Access-Control-Allow-Methods'], 'GET, HEAD, OPTIONS')
        self.assertIn('Range', response.headers['Access-Control-Allow-Headers'])
        self.assertEqual(response.headers['Access-Control-Allow-Private-Network'], 'true')
        self.assertEqual(self.request(f'/replay/{TOKEN}/live.m3u8', 'OPTIONS',
            **{'Access-Control-Request-Method': 'POST'}).status, 405)

    def test_apis_shell_and_other_transports_have_no_cast_cors(self):
        for path in ('/', '/static/player.js', '/api/status', '/api/cameras',
                     f'/api/sessions/{TOKEN}', '/service-worker.js',
                     f'/replay/{TOKEN}/video', f'/replay/{TOKEN}/preview.jpg',
                     f'/replay/{TOKEN}/frame.jpg', '/data/printers.json'):
            with self.subTest(path=path):
                response = self.request(path, 'OPTIONS', **{'Access-Control-Request-Method': 'GET'})
                self.assertEqual(response.status, 405)
                self.assertNotIn('Access-Control-Allow-Origin', response.headers)
        for path in ('/', '/api/cameras', '/api/status'):
            self.assertNotIn('Access-Control-Allow-Origin', self.request(path).headers)

    def test_csp_allows_only_cast_vendor_scripts_without_inline_or_eval(self):
        policy = self.request('/').headers['Content-Security-Policy']
        self.assertIn('https://www.gstatic.com', policy)
        self.assertIn('chrome-extension://pkedcjkdefgpdelpbcmbmeomcjbeemfm', policy)
        self.assertNotIn('unsafe-inline', policy)
        self.assertNotIn('unsafe-eval', policy)
        self.assertIn("connect-src 'self'", policy)


if __name__ == '__main__':
    unittest.main()
