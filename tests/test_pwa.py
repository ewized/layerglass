"""PWA resources use the same origin and never change private response caching."""

import json
from pathlib import Path
import struct
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen

import app


class Registry:
    def status(self, camera=None):
        return {'state': 'empty', 'camera_id': None}

    def catalog(self):
        return {'cameras': [], 'discovery': {'state': 'done'}}

    def healthy(self):
        return True


class PWATests(unittest.TestCase):
    def setUp(self):
        self.server = app.ViewerServer(('127.0.0.1', 0), registry=Registry())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def get(self, path, method='GET'):
        response = urlopen(Request(self.base + path, method=method), timeout=3)
        self.addCleanup(response.close)
        return response

    def test_manifest_and_apple_metadata(self):
        response = self.get('/manifest.webmanifest')
        self.assertEqual(response.headers['Content-Type'], 'application/manifest+json; charset=utf-8')
        manifest = json.load(response)
        self.assertEqual(manifest['id'], '/')
        self.assertEqual(manifest['start_url'], '/')
        self.assertEqual(manifest['scope'], '/')
        self.assertEqual(manifest['display'], 'standalone')
        self.assertEqual(manifest['orientation'], 'any')
        self.assertEqual({i['purpose'] for i in manifest['icons']}, {'any', 'maskable'})
        html = self.get('/').read().decode()
        self.assertIn('rel="manifest" href="/manifest.webmanifest"', html)
        self.assertIn('rel="apple-touch-icon"', html)
        self.assertIn('apple-mobile-web-app-capable', html)

    def test_real_icon_dimensions_and_head_requests(self):
        for name, size in [('icon-192.png', 192), ('icon-512.png', 512),
                           ('icon-maskable-512.png', 512), ('apple-touch-icon.png', 180)]:
            with self.subTest(name=name):
                path = '/static/icons/' + name
                response = self.get(path)
                data = response.read()
                self.assertEqual(response.headers['Content-Type'], 'image/png')
                self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
                self.assertEqual(struct.unpack('!II', data[16:24]), (size, size))
                head = self.get(path, 'HEAD')
                self.assertEqual(head.read(), b'')
                self.assertEqual(int(head.headers['Content-Length']), len(data))

    def test_root_worker_is_esm_and_revision_matches_all_shell_assets(self):
        worker = self.get('/service-worker.js')
        source = worker.read()
        self.assertIn(app.APP_SHELL_REVISION.encode(), source)
        self.assertNotIn(b'__APP_SHELL_REVISION__', source)
        self.assertNotIn(b'__PWA_CACHE_ENABLED__', source)
        self.assertTrue(source.startswith(b'import '))
        self.assertEqual(worker.headers['Content-Type'], 'text/javascript; charset=utf-8')
        for path in ('/', '/manifest.webmanifest', '/static/player.js', '/static/pwa-shell.js'):
            self.assertEqual(self.get(path).headers['X-App-Shell-Revision'], app.APP_SHELL_REVISION)
        head = self.get('/service-worker.js', 'HEAD')
        self.assertEqual(int(head.headers['Content-Length']), len(source))
        self.assertEqual(head.read(), b'')

    def test_development_worker_and_ui_responses_disable_storage(self):
        with patch.object(app, 'PWA_CACHE_ENABLED', False):
            self.assertIn(b'const cacheEnabled = false;', self.get('/service-worker.js').read())
        for path in ('/', '/service-worker.js', '/manifest.webmanifest',
                     '/static/player.js', '/static/style.css', '/static/pwa.js'):
            with self.subTest(path=path):
                self.assertEqual(self.get(path).headers['Cache-Control'], 'no-store')

    def test_offline_cache_is_explicitly_opt_in(self):
        with patch.object(app, 'PWA_CACHE_ENABLED', True):
            self.assertIn(b'const cacheEnabled = true;', self.get('/service-worker.js').read())

    def test_private_api_remains_no_store_without_shell_revision(self):
        for path in ('/api/status', '/api/cameras', '/api/snapshot', '/healthz'):
            with self.subTest(path=path):
                response = self.get(path)
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
                self.assertNotIn('X-App-Shell-Revision', response.headers)
                self.assertIn("manifest-src 'self'", response.headers['Content-Security-Policy'])

    def test_content_hash_changes_for_asset_changes_and_renames(self):
        with tempfile.TemporaryDirectory() as root, patch.object(app, 'STATIC', Path(root)):
            asset = Path(root) / 'player.js'
            asset.write_text('first release')
            first = app.app_shell_revision()
            asset.write_text('second release')
            second = app.app_shell_revision()
            self.assertNotEqual(first, second)
            asset.rename(Path(root) / 'other.js')
            self.assertNotEqual(second, app.app_shell_revision())


if __name__ == '__main__':
    unittest.main()
