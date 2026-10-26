"""Approved printer admission, internal transports, and installation migration."""

from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
from urllib.parse import unquote, urlsplit

from app import Settings, ffmpeg_command, Relay
from cameras import CameraRegistry
from discovery import Discovery
from providers import APPROVED, BY_ID, PROTOCOLS, PROVIDERS, approved_camera, discovery_ports, endpoint, probe, validate_source
from providers.base import StreamProvider
from providers.mjpeg import MjpegProvider


class StubRelay:
    def __init__(self, settings):
        self.settings = settings
        self.thread = threading.current_thread()
    def start(self): pass
    def close(self): pass
    def status(self): return {'state': 'live', 'playlist_url': None}


class CameraHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass

    def do_GET(self):
        self.server.requests.append((self.path, self.headers.get('Authorization')))
        if self.server.mode == 'redirect':
            self.send_response(302)
            self.send_header('Location', 'http://127.0.0.1:1/stream')
            self.end_headers()
            return
        if self.server.mode != 'camera' or self.path != '/stream':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<html>A printer control page is not a camera</html>')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        self.end_headers()
        try:
            for _ in range(600):
                frame = self.server.frame
                self.wfile.write(b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + str(len(frame)).encode() + b'\r\n\r\n' + frame + b'\r\n')
                self.wfile.flush()
                time.sleep(1 / 15)
        except OSError:
            pass


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, {'CAMERA_DATA_DIR': self.temp.name, 'DISCOVERY_CIDRS': ''})
        env.start()
        self.addCleanup(env.stop)

    def registry(self, source='', **kwargs):
        registry = CameraRegistry(Settings(source), StubRelay, **kwargs)
        self.addCleanup(registry.close)
        return registry

    def http_camera(self, mode='camera', frame=b'\xff\xd8fixture\xff\xd9'):
        server = ThreadingHTTPServer(('127.0.0.1', 0), CameraHandler)
        server.mode, server.frame, server.requests = mode, frame, []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def test_generic_rtsp_has_no_manufacturer_auth_or_path_assumptions(self):
        source = 'rtsps://viewer:generic-password@192.168.50.8:322/custom'
        item = endpoint(source)
        self.assertEqual(item['provider'], 'rtsp')
        self.assertIsNone(item['manufacturer'])
        self.assertEqual(item['setup'], {'type': 'connection', 'path': '/'})
        self.assertEqual(item['name'], '192.168.50.8')
        self.assertNotIn('generic-password', json.dumps(item))
        self.assertNotIn('/custom', json.dumps(item))

    def test_only_approved_camera_profiles_supply_scan_ports(self):
        self.assertEqual(discovery_ports(), {6000: 'bambu', 322: 'rtsps'})
        self.assertEqual(discovery_ports('rtsps:322'), discovery_ports())
        for value in ('http:8082', 'rtsp:10554', 'rtsps:8554', 'bambu:322', 'http:0', 'rtsp:65536', 'unknown:8082', 'invalid'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                discovery_ports(value)

    def test_rtsp_discovery_uses_only_a_protocol_probe_without_credentials(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            received = []
            def serve():
                connection, _ = listener.accept()
                with connection:
                    received.append(connection.recv(4096))
                    connection.sendall(b'RTSP/1.0 401 Unauthorized\r\n\r\n')
            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            item = probe('127.0.0.1', listener.getsockname()[1], 'rtsp', Discovery().tls)
            thread.join(timeout=2)
        self.assertEqual(item['provider'], 'rtsp')
        self.assertNotIn(b'Authorization', received[0])
        self.assertNotIn(b'bblp', received[0])
        self.assertNotIn(b'/streaming/live/1', received[0])

    def test_http_discovery_verifies_mjpeg_and_never_follows_web_redirects(self):
        for mode in ('html', 'redirect', 'camera'):
            with self.subTest(mode=mode):
                server = self.http_camera(mode)
                item = probe('127.0.0.1', server.server_port, 'http', Discovery().tls)
                if mode == 'camera':
                    self.assertEqual(item['provider'], 'mjpeg')
                    self.assertEqual(item['setup']['path'], '/stream')
                else:
                    self.assertIsNone(item)
                self.assertTrue(server.requests)
                self.assertTrue(all(auth is None for _, auth in server.requests))

    def test_generic_candidates_cannot_be_listed_paired_or_started(self):
        telemetry = Mock()
        registry = self.registry(telemetry_factory=telemetry)
        items = [endpoint(source) for source in ('rtsp://192.168.50.8:8554/',
                 'rtsps://192.168.50.9:322/', 'http://192.168.50.10:8080/stream')]
        registry.discovery.found = items
        self.assertEqual(registry.catalog()['cameras'], [])
        for item in items:
            with self.subTest(kind=item['kind']), self.assertRaises(ValueError):
                registry.configure(item['id'], path='/stream', username='viewer', password='code')
            self.assertIsNone(registry.get_relay(item['id']))
        self.assertEqual(registry.sources, {})
        telemetry.assert_not_called()

    def test_old_generic_settings_are_retained_privately_and_never_started(self):
        source = 'rtsp://viewer:saved-code@192.168.50.8:8554/custom'
        key = endpoint(source)['id']
        store = Path(self.temp.name) / 'printers.json'
        store.write_text(json.dumps({'version': 3, 'sources': {key: source},
                                     'providers': {key: 'rtsp'}, 'identities': {}}))
        registry = self.registry()
        self.assertEqual(registry.sources[key], source)
        self.assertIsNone(registry.default_id)
        self.assertEqual(registry.catalog()['cameras'], [])
        self.assertIsNone(registry.get_relay(key))
        self.assertIsNone(registry.get_telemetry(key))
        self.assertNotIn('saved-code', json.dumps(registry.status(key)))
        registry._save(registry.sources, registry.forgotten)
        self.assertEqual(json.loads(store.read_text())['sources'][key], source)

    def test_printer_configuration_uses_only_the_approved_endpoint(self):
        registry = self.registry(telemetry_factory=Mock())
        item = dict(endpoint('rtsps://192.168.50.8:322/', provider='bambu'), model='N6')
        registry.discovery.found = [item]
        for fields in ({'path': '/custom'}, {'username': 'viewer'}, {'password': 'code'}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                registry.configure(item['id'], 'test-code', **fields)
        self.assertEqual(registry.sources, {})
        registry.configure(item['id'], 'test-code')
        self.assertEqual(registry.sources[item['id']], 'rtsps://bblp:test-code@192.168.50.8:322/streaming/live/1')

    def test_source_urls_are_limited_to_approved_stream_profiles(self):
        validate_source('rtsps://bblp:code@192.168.50.2:322/streaming/live/1')
        validate_source('bambu://bblp:code@192.168.50.3:6000/streaming/live/1')
        for source in ('rtsp://192.168.50.2:554/stream', 'http://192.168.50.2:8080/stream',
                       'rtsps://bblp:code@192.168.50.2:8554/streaming/live/1',
                       'rtsps://bblp:code@192.168.50.2:322/custom',
                       'rtsps://viewer:code@192.168.50.2:322/streaming/live/1',
                       'rtsps://bblp:code@192.168.50.2:322/streaming/live/1?channel=2'):
            with self.subTest(source=source), self.assertRaises(ValueError):
                validate_source(source)

    def test_v2_printer_codes_names_and_forget_list_migrate_without_repairing(self):
        source = 'rtsps://bblp:existing-code@192.168.50.2:322/streaming/live/1'
        key = endpoint(source)['id']
        store = Path(self.temp.name) / 'printers.json'
        store.write_text(json.dumps({'version': 2, 'sources': {key: source}, 'forgotten': ['f' * 16],
                                     'identities': {key: {'name': 'Existing printer', 'serial': '20P000000000001'}}}))
        registry = self.registry()
        self.assertEqual(registry.sources[key], source)
        self.assertEqual(registry.catalog()['cameras'][0]['setup']['type'], 'access_code')
        self.assertEqual(registry.catalog()['cameras'][0]['name'], 'Existing printer')
        with patch('providers.bambu.PrinterTelemetry'):
            registry.configure(key, 'updated-code')
        saved = json.loads(store.read_text())
        self.assertEqual(saved['version'], 3)
        self.assertEqual(saved['forgotten'], ['f' * 16])
        self.assertEqual(saved['providers'][key], 'bambu')
        self.assertEqual(saved['identities'][key]['name'], 'Existing printer')
        self.assertEqual(store.stat().st_mode & 0o777, 0o600)

    def test_new_adapter_requires_explicit_approval_before_admission(self):
        class AdditionalProvider(StreamProvider):
            id = 'additional'
            manufacturer = 'Fixture manufacturer'
            protocols = {'fixturecam': 9999}
            ports = {9999: 'fixturecam'}
            def approved_stream(self, item):
                return item.get('model') == 'fixture-model' and item['kind'] == 'fixturecam' and item['port'] == 9999
            def accepts_source(self, source):
                return source.startswith('fixturecam://') and urlsplit(source).path == '/video'
            def public(self, item):
                return dict(super().public(item), setup={'type': 'access_code'})
            def configure(self, item, values, previous=None):
                return f'fixturecam://{item["host"]}:9999/video'
        adapter = AdditionalProvider()
        with patch('providers.PROVIDERS', (*PROVIDERS, adapter)), patch.dict(BY_ID, {adapter.id: adapter}), patch.dict(PROTOCOLS, {'fixturecam': adapter}):
            registry = self.registry()
            item = dict(endpoint('fixturecam://192.168.50.8:9999/'), model='fixture-model')
            registry.discovery.found = [item]
            self.assertNotIn(9999, discovery_ports())
            self.assertFalse(approved_camera(item))
            self.assertEqual(registry.catalog()['cameras'], [])
            with patch.dict(APPROVED, {adapter.id: {'fixturecam': {'models': ['fixture-model'], 'port': 9999, 'path': '/video'}}}):
                self.assertEqual(discovery_ports()[9999], 'fixturecam')
                registry.configure(item['id'], 'fixture-code')
                self.assertEqual(registry.catalog()['cameras'][0]['manufacturer'], 'Fixture manufacturer')
                self.assertEqual(registry.get_relay(item['id']).settings.stream_url, 'fixturecam://192.168.50.8:9999/video')

    def test_real_http_mjpeg_relay_transcodes_into_the_existing_video_pipeline(self):
        frame = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                                'testsrc2=size=160x120:rate=15', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-threads', '1', '-'],
                               capture_output=True, check=True, timeout=10).stdout
        server = self.http_camera(frame=frame)
        source = f'http://127.0.0.1:{server.server_port}/stream'
        settings = replace(Settings(source), stream_root=Path(self.temp.name) / 'hls')
        # Transport reuse remains available to future approved adapters. It
        # does not grant generic HTTP cameras admission to the printer list.
        relay = MjpegProvider().create_relay(settings, Relay)
        self.addCleanup(relay.close)
        relay.start()
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline and relay.status()['state'] != 'live':
            time.sleep(0.2)
        self.assertEqual(relay.status()['state'], 'live')
        command = ffmpeg_command(relay.settings, Path(self.temp.name))
        self.assertIn('libx264', command)
        self.assertNotIn('-rtsp_transport', command)
        self.assertTrue(list(settings.stream_root.rglob('segment-*.ts')))
