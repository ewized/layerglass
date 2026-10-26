"""Opted-in hosted frontends use real CORS requests without opening other origins."""
from copy import deepcopy
from http.client import HTTPConnection
import json
import os
import tempfile
import threading
import unittest
from unittest.mock import patch

from app import Settings, ViewerServer, configured_origins
from cameras import CameraRegistry
from providers import endpoint
from test_cameras import FakeRelay, FakeTelemetry
from test_events import Registry, Replay, CAMERA, TOKEN


class BackendCorsTests(unittest.TestCase):
    def setUp(self):
        self.server = ViewerServer(('127.0.0.1', 0), registry=Registry(), replay=Replay(),
            allowed_origins='https://app.layer.glass', backend_origins='https://printer.example.com')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, method='GET', origin='https://app.layer.glass', headers=None, body=None):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        self.addCleanup(connection.close)
        connection.request(method, path, body=body, headers={'Origin': origin, 'Connection': 'close', **(headers or {})})
        return connection.getresponse()

    def test_exact_origin_preflight_is_scoped_and_never_credentialed(self):
        response = self.request('/api/sessions', 'OPTIONS', headers={
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type,x-viewer-request',
            'Access-Control-Request-Private-Network': 'true'})
        self.assertEqual(response.status, 204)
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), 'https://app.layer.glass')
        self.assertEqual(response.getheader('Vary'), 'Origin')
        self.assertIsNone(response.getheader('Access-Control-Allow-Credentials'))
        self.assertEqual(response.getheader('Access-Control-Allow-Private-Network'), 'true')
        response.read()
        for path in ('/', '/static/player.js', '/data/printers.json'):
            response = self.request(path, 'OPTIONS', headers={'Access-Control-Request-Method': 'GET'})
            self.assertEqual(response.status, 405)
            self.assertIsNone(response.getheader('Access-Control-Allow-Origin'))

    def test_untrusted_origins_and_extra_headers_are_rejected(self):
        for origin in ('https://app.layer.glass.evil.test', 'http://app.layer.glass', 'null'):
            response = self.request('/api/snapshot', origin=origin)
            self.assertEqual(response.status, 403)
            self.assertIsNone(response.getheader('Access-Control-Allow-Origin'))
        response = self.request('/api/sessions', 'OPTIONS', headers={
            'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization'})
        self.assertEqual(response.status, 405)

    def test_description_and_snapshot_work_with_exact_origin(self):
        response = self.request('/api/backend')
        body = json.loads(response.read())
        self.assertEqual(body['id'], 'python')
        self.assertEqual(body['protocol_version'], 1)
        self.assertTrue(body['capabilities']['discovery'])
        response = self.request(f'/api/snapshot?camera={CAMERA}&session={TOKEN}')
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.read())['replay']['session_id'], TOKEN)

    def scan_registry(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        environment = patch.dict(os.environ, {'CAMERA_DATA_DIR': temporary.name, 'DISCOVERY_CIDRS': ''})
        environment.start()
        self.addCleanup(environment.stop)
        code = 'fixture-scan-code'
        source = f'rtsps://bblp:{code}@192.0.2.1:322/streaming/live/1'
        registry = CameraRegistry(Settings(source), FakeRelay, telemetry_factory=FakeTelemetry)
        self.addCleanup(registry.close)
        discovery = registry.discovery
        item = dict(endpoint(source, provider='bambu'), model='N6', serial='20P000000000001',
                    identification='mqtt', name=f'Printer {code} {source}')
        discovery.found = [item]
        discovery.cache.put((item['host'], item['port'], item['kind']), item, 100)
        discovery.clock = lambda: 100
        discovery.state = 'done'
        discovery.started = discovery.completed = 100
        discovery.finished_at = 1
        discovery.checked, discovery.total, discovery.cached, discovery.probed = 5, 6, 2, 3
        discovery.names_cached = True
        self.server.registry = registry
        response = self.request('/api/cameras')
        self.assertEqual(response.status, 200)
        catalog = json.loads(response.read())
        self.assertNotIn(code, json.dumps(catalog))
        self.assertNotIn(source, json.dumps(catalog))
        self.assertTrue(catalog['cameras'][0]['configured'])
        return registry, code, source

    def assert_public_scan(self, registry, code, source, queued):
        discovery = registry.discovery
        candidates = deepcopy(discovery.found)
        cache = deepcopy(discovery.cache.entries)
        binding = deepcopy((registry.sources, registry.identities, registry.quarantined))
        for origin, headers in (('https://untrusted.test', {'X-Viewer-Request': '1'}),
                                ('https://app.layer.glass', {})):
            response = self.request('/api/discover', 'POST', origin=origin, headers=headers, body='{}')
            self.assertEqual(response.status, 403)
            response.read()
        response = self.request('/api/discover', 'POST', headers={'X-Viewer-Request': '1'}, body='{}')
        self.assertEqual(response.status, 202)
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), 'https://app.layer.glass')
        self.assertIsNone(response.getheader('Access-Control-Allow-Credentials'))
        result = json.loads(response.read())
        progress = {key: value for key, value in discovery.status().items() if key != 'found'}
        self.assertEqual(result, {'ok': True, 'queued': queued,
                                  'retry_after_seconds': discovery.retry_after(), 'discovery': progress})
        self.assertNotIn('found', result['discovery'])
        self.assertNotIn(code, json.dumps(result))
        self.assertNotIn(source, json.dumps(result))
        self.assertEqual(discovery.found, candidates)
        self.assertEqual(discovery.cache.entries, cache)
        self.assertEqual((registry.sources, registry.identities, registry.quarantined), binding)
        camera = registry._source_camera(candidates[0]['id'])
        self.assertEqual((camera['model'], camera['serial']), ('N6', '20P000000000001'))

    def test_scan_cooldown_returns_only_public_progress(self):
        registry, code, source = self.scan_registry()
        self.assert_public_scan(registry, code, source, queued=False)
        self.assertIsNone(registry.discovery.thread)

    def test_queued_scan_keeps_prior_candidates_private(self):
        registry, code, source = self.scan_registry()
        registry.discovery.started = registry.discovery.completed = 89
        finish = threading.Event()
        # Exercise actual queueing without starting network probes or name lookup.
        with patch.object(registry.discovery, '_targets', return_value=[]), \
                patch.object(registry.discovery, '_run', side_effect=finish.wait):
            try:
                self.assert_public_scan(registry, code, source, queued=True)
            finally:
                finish.set()
                if registry.discovery.thread:
                    registry.discovery.thread.join(timeout=2)
        self.assertFalse(registry.discovery.thread.is_alive())

    def test_backend_only_mode_disables_shell_but_keeps_hosted_apis(self):
        self.server.serve_ui = False
        for path in ('/', '/static/bootstrap.js', '/static/style.css', '/manifest.webmanifest', '/service-worker.js'):
            for method in ('GET', 'HEAD'):
                response = self.request(path, method)
                self.assertEqual(response.status, 404)
                self.assertIsNone(response.getheader('Access-Control-Allow-Origin'))
                response.read()
        response = self.request('/api/backend')
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), 'https://app.layer.glass')
        self.assertEqual(json.loads(response.read())['id'], 'python')
        response = self.request(f'/api/snapshot?camera={CAMERA}&session={TOKEN}')
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.read())['replay']['session_id'], TOKEN)

    def test_trusted_origin_still_requires_the_viewer_csrf_header(self):
        response = self.request(f'/api/sessions/{TOKEN}/close', 'POST', body='{}')
        self.assertEqual(response.status, 403)
        response.read()
        response = self.request('/api/restart', 'POST', origin='https://untrusted.test',
            headers={'X-Viewer-Request': '1'}, body='{}')
        self.assertEqual(response.status, 403)

    def test_outbound_ui_policy_only_adds_explicit_backend_origins(self):
        response = self.request('/')
        policy = response.getheader('Content-Security-Policy')
        self.assertIn("connect-src 'self' https://printer.example.com", policy)
        self.assertNotIn('connect-src *', policy)
        self.assertNotIn('app.layer.glass', policy)

    def test_origin_config_rejects_csp_injection_and_wildcard(self):
        self.assertEqual(configured_origins({'https://app.layer.glass'}), frozenset({'https://app.layer.glass'}))
        for origin in ('*', 'https://*.layer.glass', 'https://app.layer.glass/path',
                'https://user:secret@app.layer.glass', "https://bad';script-src", 'https://example.com:99999'):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                configured_origins(origin)


if __name__ == '__main__':
    unittest.main()
