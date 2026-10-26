"""Independent browser projects remain public assets, with bounded asset roots."""
from http.client import HTTPConnection
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import app
from test_pwa import Registry


class BrowserModuleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.module = root / 'src'
        self.module.mkdir()
        (self.module / 'index.js').write_text('export const local = true;')
        (self.module / 'clip.mp4').write_bytes(b'0123456789')
        (root / 'private.json').write_text('not public')
        modules = patch.object(app, 'BROWSER_MODULES', {'/local-backend/src/': self.module})
        modules.start()
        self.addCleanup(modules.stop)
        self.server = app.ViewerServer(('127.0.0.1', 0), registry=Registry())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def get(self, path, headers=None):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        self.addCleanup(connection.close)
        connection.request('GET', path, headers=headers or {})
        return connection.getresponse()

    def test_native_module_and_media_keep_freshness_mime_and_ranges(self):
        response = self.get('/local-backend/src/index.js')
        self.assertEqual(response.status, 200)
        self.assertIn('javascript', response.getheader('Content-Type'))
        self.assertEqual(response.getheader('Cache-Control'), 'no-store')
        self.assertEqual(response.read(), b'export const local = true;')
        response = self.get('/local-backend/src/clip.mp4', {'Range': 'bytes=2-4'})
        self.assertEqual(response.status, 206)
        self.assertEqual(response.getheader('Content-Range'), 'bytes 2-4/10')
        self.assertEqual(response.read(), b'234')

    def test_module_roots_do_not_expose_configuration_or_python_sources(self):
        for path in ['/local-backend/src/../private.json', '/local-backend/src/%2e%2e/private.json',
                     '/local-backend/project.json', '/python-backend/app.py']:
            with self.subTest(path=path):
                response = self.get(path)
                self.assertEqual(response.status, 404)
                response.read()

    def test_api_only_backend_disables_independent_browser_assets_too(self):
        self.server.serve_ui = False
        response = self.get('/local-backend/src/index.js')
        self.assertEqual(response.status, 404)
        response.read()

    def test_shell_revision_includes_backend_module_changes(self):
        before = app.app_shell_revision()
        (self.module / 'index.js').write_text('export const local = false;')
        self.assertNotEqual(app.app_shell_revision(), before)
