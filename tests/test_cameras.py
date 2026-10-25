from dataclasses import replace
import json
import os
from pathlib import Path
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen

from app import Settings, ViewerServer
from cameras import CameraRegistry
from providers.bambu.jpeg import JpegRelay
from discovery import Discovery, endpoint as stream_endpoint, scan_networks
from providers import probe as transport_probe


# Existing manufacturer-specific pairing fixtures explicitly select their adapter.
def endpoint(source):
    item = stream_endpoint(source, provider='bambu')
    return dict(item, model='C12' if item['kind'] == 'bambu' else 'N6')


SOURCE = 'rtsps://bblp:fixture-secret@192.168.50.2:322/streaming/live/1'


class FakeRelay:
    def __init__(self, settings):
        self.settings = settings
        self.thread = threading.current_thread()
        self.generation = 'a' * 32
        self.restarts = 0
        self.closed = False

    def start(self):
        pass

    def close(self):
        self.closed = True

    def status(self):
        return {'state': 'live', 'message': 'Camera connected.', 'generation': self.generation,
                'playlist_url': f'/stream/{self.generation}/live.m3u8'}

    def request_restart(self):
        self.restarts += 1
        return True


class FakeTelemetry:
    def __init__(self, source, saved=None, on_identity=None):
        self.source = source
        self.saved = saved
        self.on_identity = on_identity
        self.closed = False

    def start(self):
        pass

    def close(self):
        self.closed = True

    def status(self):
        return {'connection': 'connected', 'print_state': 'RUNNING', 'progress': 42}


class DiscoveryTests(unittest.TestCase):
    def test_x2d_control_port_is_not_discovered_as_a_jpeg_camera(self):
        scanner = Discovery(SOURCE)
        scanner.identifier = Mock()
        scanner.identifier.identify.return_value = {'provider': 'bambu', 'model': 'N6', 'serial': '20P000000000001'}
        with patch('discovery.socket.create_connection') as raw, patch.object(scanner.tls, 'wrap_socket') as wrap:
            raw.return_value.__enter__.return_value.settimeout.return_value = None
            wrap.return_value.__enter__.return_value = wrap.return_value
            with patch('providers.bambu.certificate_identity', return_value={'serial': '20P000000000001'}):
                self.assertIsNone(scanner._probe('192.168.50.2', 6000, 'bambu'))

    def test_scan_merges_announced_names_into_discovered_streams(self):
        scanner = Discovery('', '192.168.50.2/32')
        metadata = {'192.168.50.2': {'name': 'Print room', 'model': 'N6', 'serial': '20P000000000001'}}
        def probe(host, port, kind):
            return endpoint(SOURCE) if port == 322 else None
        with patch('discovery.discover_names', return_value=metadata), patch.object(scanner, '_probe', side_effect=probe):
            self.assertTrue(scanner.start())
            scanner.thread.join(timeout=3)
        result = scanner.status()
        self.assertEqual(result['state'], 'done')
        self.assertEqual(result['checked'], result['total'])
        self.assertEqual(result['found'][0]['name'], 'Print room')
        self.assertEqual(result['found'][0]['model'], 'N6')

    def test_scan_is_bounded_and_defaults_to_configured_printer_subnet(self):
        self.assertEqual([str(net) for net in scan_networks(SOURCE, '')], ['192.168.50.0/24'])
        self.assertEqual(scan_networks('', ''), ())
        for value in ['0.0.0.0/0', '8.8.8.0/24', '192.168.0.0/16', '::1/128', 'invalid']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                scan_networks('', value)

    def test_probe_requires_rtsp_response_and_never_sends_credentials(self):
        for response, expected in [(b'RTSP/1.0 401 Unauthorized\r\n\r\n', True),
                                   (b'HTTP/1.1 200 OK\r\n\r\n', False)]:
            with self.subTest(response=response), socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                listener.listen()
                received = []

                def serve():
                    connection, _ = listener.accept()
                    with connection:
                        received.append(connection.recv(4096))
                        connection.sendall(response)

                thread = threading.Thread(target=serve, daemon=True)
                thread.start()
                found = transport_probe('127.0.0.1', listener.getsockname()[1], 'rtsp', Discovery().tls)
                thread.join(timeout=2)
                self.assertEqual(found is not None, expected)
                self.assertIn(b'OPTIONS ', received[0])
                self.assertNotIn(b'fixture-secret', received[0])

    def test_scan_keeps_previous_results_until_replacement_and_is_not_duplicated(self):
        scanner = Discovery('', '192.168.50.0/30')
        old = endpoint(SOURCE)
        scanner.found = [old]
        release = threading.Event()

        def probe(*_args):
            release.wait(2)
            return None

        with patch.object(scanner, '_probe', side_effect=probe), patch('discovery.discover_names', return_value={}):
            self.assertTrue(scanner.start())
            self.assertRegex(scanner.status()['scan_id'], r'^[a-f0-9]{32}$')
            self.assertFalse(scanner.start())
            self.assertEqual(scanner.status()['found'], [old])
            release.set()
            scanner.thread.join(timeout=3)
        self.assertEqual(scanner.status()['found'], [])
        self.assertEqual(scanner.status()['state'], 'done')


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.environment = patch.dict(os.environ, {'CAMERA_DATA_DIR': self.temp.name, 'DISCOVERY_CIDRS': '192.168.50.0/24'})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        telemetry = patch('providers.bambu.PrinterTelemetry', FakeTelemetry)
        telemetry.start()
        self.addCleanup(telemetry.stop)
        self.registry = CameraRegistry(Settings(SOURCE), FakeRelay)
        self.registry.discovery.found = [endpoint(SOURCE), endpoint('rtsps://192.168.50.3:322/streaming/live/1')]
        self.registry.discovery.state = 'done'
        self.server = ViewerServer(('127.0.0.1', 0), registry=self.registry)
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.http = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.http.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.registry.close()

    def get(self, path):
        with urlopen(self.base + path, timeout=3) as response:
            return json.load(response)

    def post(self, path, data=None, headers=None):
        request = Request(self.base + path, data=json.dumps(data or {}).encode(),
                          headers=headers if headers is not None else {'X-Viewer-Request': '1'})
        return urlopen(request, timeout=5)

    def test_new_camera_needs_its_own_code_and_api_hides_credentials(self):
        catalog = self.get('/api/cameras')
        self.assertEqual(len(catalog['cameras']), 2)
        other = next(item for item in catalog['cameras'] if not item['configured'])
        status = self.get('/api/status?camera=' + other['id'])
        self.assertEqual(status['state'], 'setup')
        self.assertNotIn(other['id'], self.registry.relays)
        self.assertNotIn('fixture-secret', json.dumps([catalog, status]))
        self.assertNotIn('rtsps://', json.dumps(catalog))

    def test_catalog_uses_camera_ids_then_serials_until_a_friendly_name_is_reported(self):
        cameras = self.get('/api/cameras')['cameras']
        self.assertTrue(all(camera['name'] == f"Camera {camera['id'][:8]}" for camera in cameras))
        key = endpoint(SOURCE)['id']
        self.registry.get_relay(key)
        relay = self.registry.relays[key]
        telemetry = self.registry.telemetry[key]
        telemetry.on_identity({'model': 'N6', 'serial': '20P000000000001'})
        camera = next(camera for camera in self.get('/api/cameras')['cameras'] if camera['id'] == key)
        self.assertEqual(camera['name'], '20P000000000001')
        self.assertEqual(CameraRegistry(Settings(SOURCE), FakeRelay).catalog()['cameras'][0]['name'], camera['name'])
        telemetry.on_identity({'name': 'Print room'})
        camera = next(camera for camera in self.get('/api/cameras')['cameras'] if camera['id'] == key)
        self.assertEqual(camera['name'], 'Print room')
        self.assertIs(self.registry.relays[key], relay)
        self.assertFalse(relay.closed)

    def test_printer_names_are_cached_and_telemetry_is_shared_by_viewers(self):
        key = endpoint(SOURCE)['id']
        self.registry.get_relay(key)
        telemetry = self.registry.telemetry[key]
        telemetry.on_identity({'name': 'Workshop X2D', 'model': 'N6', 'serial': '20P000000000001'})
        for _ in range(3):
            self.assertEqual(self.get('/api/status?camera=' + key)['printer']['progress'], 42)
        self.assertIs(self.registry.telemetry[key], telemetry)
        self.assertEqual(len(self.registry.telemetry), 1)
        self.assertEqual(self.get('/api/cameras')['cameras'][0]['name'], 'Workshop X2D')
        reloaded = CameraRegistry(Settings(SOURCE), FakeRelay)
        self.assertEqual(reloaded.catalog()['cameras'][0]['name'], 'Workshop X2D')
        self.registry.forget(key)
        self.assertTrue(telemetry.closed)
        telemetry.on_identity({'name': 'Late report'})
        self.assertNotIn(key, self.registry.identities)
        self.assertNotIn(key, json.loads(self.registry.store.read_text())['identities'])

    def test_announced_name_survives_firmware_reports_and_cached_catalog_reads(self):
        key = endpoint(SOURCE)['id']
        self.registry.discovery.found[0].update(name='Print room', model='N6')
        self.assertEqual(self.registry.catalog()['cameras'][0]['name'], 'Print room')
        self.registry.get_relay(key)
        self.registry.telemetry[key].on_identity({'firmware': '01.02.00.00'})
        self.assertEqual(self.registry.catalog()['cameras'][0]['name'], 'Print room')
        self.registry.telemetry[key].on_identity({'name': 'Enclosure printer'})
        self.assertEqual(self.registry.catalog()['cameras'][0]['name'], 'Enclosure printer',
                         'Cached discovery results must not overwrite a newer MQTT name.')
        self.registry.discovery.found[0]['name'] = 'Renamed on printer'
        self.registry.discovery.finished_at = time.time()
        self.assertEqual(self.registry.catalog()['cameras'][0]['name'], 'Renamed on printer')

    def test_configuration_persists_privately_and_restart_is_scoped_to_selection(self):
        first = endpoint(SOURCE)['id']
        second = endpoint('rtsps://192.168.50.3:322/streaming/live/1')['id']
        self.get('/api/status?camera=' + first)
        with self.post(f'/api/cameras/{second}/configure', {'access_code': 'second-secret'}):
            pass
        saved = Path(self.temp.name) / 'printers.json'
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        reloaded = CameraRegistry(Settings(SOURCE), FakeRelay)
        self.assertEqual(unquote(urlsplit(reloaded.sources[second]).password), 'second-secret')
        self.assertEqual(unquote(urlsplit(reloaded.sources[first]).password), 'fixture-secret')
        self.assertEqual(unquote(urlsplit(self.registry.sources[first]).password), 'fixture-secret')
        with self.post('/api/restart?camera=' + second):
            pass
        self.assertEqual(self.registry.relays[first].restarts, 0)
        self.assertEqual(self.registry.relays[second].restarts, 1)
        self.assertNotIn('second-secret', json.dumps(self.get('/api/cameras')))
        self.assertIn('/stream/' + second + '/', self.get('/api/status?camera=' + second)['playlist_url'])

    def test_forgetting_a_printer_removes_only_its_code_and_relay(self):
        first = endpoint(SOURCE)['id']
        second = endpoint('rtsps://192.168.50.3:322/streaming/live/1')['id']
        self.registry.configure(second, 'second-secret')
        first_relay = self.registry.get_relay(first)
        second_relay = self.registry.get_relay(second)
        with self.post(f'/api/cameras/{first}/forget'):
            pass
        self.assertTrue(first_relay.closed)
        self.assertFalse(second_relay.closed)
        self.assertEqual(self.registry.default_id, second)
        self.assertEqual([item['id'] for item in self.get('/api/cameras')['cameras']], [second])
        self.assertEqual(self.get('/api/status?camera=' + first)['state'], 'empty')
        saved = (Path(self.temp.name) / 'printers.json').read_text()
        self.assertNotIn('fixture-secret', saved)
        reloaded = CameraRegistry(Settings(SOURCE), FakeRelay)
        self.assertNotIn(first, reloaded.sources, 'STREAM_URL must not restore a forgotten access code after restart.')
        self.assertEqual(unquote(urlsplit(reloaded.sources[second]).password), 'second-secret')

    def test_forgotten_candidate_can_be_discovered_again_but_needs_a_new_code(self):
        first = endpoint(SOURCE)['id']
        self.registry.forget(first)
        self.assertNotIn(first, {item['id'] for item in self.registry.catalog()['cameras']})
        self.registry.discovery.finished_at = time.time()
        self.assertEqual(self.registry.status(first)['state'], 'setup')
        self.assertNotIn(first, self.registry.sources)
        self.registry.configure(first, 'replacement-code')
        reloaded = CameraRegistry(Settings(SOURCE), FakeRelay)
        self.assertEqual(unquote(urlsplit(reloaded.sources[first]).password), 'replacement-code')

    def test_forget_removes_unconfigured_candidates_and_rejects_unknown_ids(self):
        other = next(item for item in self.registry.catalog()['cameras'] if not item['configured'])
        with self.post(f'/api/cameras/{other["id"]}/forget'):
            pass
        self.assertNotIn(other['id'], {item['id'] for item in self.registry.catalog()['cameras']})
        with self.assertRaises(HTTPError) as error:
            self.post('/api/cameras/0000000000000000/forget')
        self.assertEqual(error.exception.code, 400)

    def test_failed_persistence_does_not_forget_a_printer(self):
        first = endpoint(SOURCE)['id']
        relay = self.registry.get_relay(first)
        with patch.object(self.registry, '_save', side_effect=OSError('Disk unavailable')):
            with self.assertRaises(HTTPError) as error:
                self.post(f'/api/cameras/{first}/forget')
        self.assertEqual(error.exception.code, 500)
        self.assertIn(first, self.registry.sources)
        self.assertFalse(relay.closed)

    def test_discover_response_identifies_the_scan_for_console_deduplication(self):
        self.registry.discovery.scan_id = 'd' * 32
        with patch.object(self.registry.discovery, 'start', return_value=False):
            with self.post('/api/discover') as response:
                result = json.load(response)
        self.assertFalse(result['queued'])
        self.assertEqual(result['discovery']['scan_id'], 'd' * 32)

    def test_legacy_saved_pairs_load_and_migrate_on_the_next_change(self):
        first = endpoint(SOURCE)['id']
        saved = Path(self.temp.name) / 'printers.json'
        saved.write_text(json.dumps({first: SOURCE.replace('fixture-secret', 'saved-secret')}))
        reloaded = CameraRegistry(Settings(SOURCE), FakeRelay)
        self.assertEqual(unquote(urlsplit(reloaded.sources[first]).password), 'saved-secret')
        reloaded.discovery.found = [endpoint(SOURCE)]
        reloaded.configure(first, 'updated-secret')
        self.assertEqual(json.loads(saved.read_text())['version'], 3)
        again = CameraRegistry(Settings(SOURCE), FakeRelay)
        self.assertEqual(unquote(urlsplit(again.sources[first]).password), 'updated-secret')

    def test_empty_registry_and_cross_origin_mutations(self):
        empty = CameraRegistry(Settings(''), FakeRelay)
        self.assertEqual(empty.status()['state'], 'empty')
        self.assertEqual(empty.catalog()['cameras'], [])
        for path in ['/api/discover', '/api/restart', f'/api/cameras/{endpoint(SOURCE)["id"]}/configure',
                     f'/api/cameras/{endpoint(SOURCE)["id"]}/forget']:
            for headers in [{}, {'X-Viewer-Request': '1', 'Origin': 'https://other.example'}]:
                with self.subTest(path=path, headers=headers), self.assertRaises(HTTPError) as error:
                    self.post(path, headers=headers)
                self.assertEqual(error.exception.code, 403)

    def test_closed_saved_endpoint_is_not_reported_as_discovered(self):
        self.registry.catalog()
        self.registry.discovery.found = [endpoint('bambu://192.168.50.5:6000/live')]
        cameras = self.registry.catalog()['cameras']
        self.assertFalse(next(item for item in cameras if item['configured'])['discovered'])
        self.assertTrue(next(item for item in cameras if item['kind'] == 'bambu')['discovered'])

    def test_discovery_adds_to_known_printers_without_dropping_previous_candidates(self):
        initial = self.registry.catalog()
        known = {item['id'] for item in initial['cameras']}
        new = endpoint('rtsps://192.168.50.4:322/streaming/live/1')
        self.registry.discovery.found = [new]
        catalog = self.registry.catalog()
        self.assertEqual({item['id'] for item in catalog['cameras']}, known | {new['id']})
        self.assertTrue(next(item for item in catalog['cameras'] if item['id'] == new['id'])['discovered'])
        self.assertFalse(next(item for item in catalog['cameras'] if item['id'] in known)['discovered'])
        self.assertNotIn('fixture-secret', json.dumps(catalog))


class NativeCameraTests(unittest.TestCase):
    def test_discovery_waits_for_slow_printer_tls_handshake(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket() as listener:
            root = Path(directory)
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                            '-keyout', str(root / 'key'), '-out', str(root / 'cert'),
                            '-days', '1', '-subj', '/CN=localhost'],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(root / 'cert', root / 'key')
            listener.bind(('127.0.0.1', 0))
            listener.listen()

            def serve():
                raw, _ = listener.accept()
                time.sleep(1.2)
                with tls.wrap_socket(raw, server_side=True) as connection:
                    connection.recv(4096)
                    connection.sendall(b'RTSP/1.0 401 Unauthorized\r\n\r\n')

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            found = transport_probe('127.0.0.1', listener.getsockname()[1], 'rtsps', Discovery().tls)
            thread.join(timeout=2)
            self.assertIsNotNone(found, 'Slow printer TLS must not cause a false negative.')

    def test_authenticated_fragmented_jpeg_frames_and_reconnect(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket() as listener:
            root = Path(directory)
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                            '-keyout', str(root / 'key'), '-out', str(root / 'cert'),
                            '-days', '1', '-subj', '/CN=localhost'],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(root / 'cert', root / 'key')
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            auth = []
            stop = threading.Event()
            frame = b'\xff\xd8fixture-jpeg\xff\xd9'

            def serve():
                raw, _ = listener.accept()
                with tls.wrap_socket(raw, server_side=True) as connection:
                    auth.append(JpegRelay._read(connection, 80))
                    packet = struct.pack('<IIII', len(frame), 0, 1, 0) + frame
                    connection.sendall(packet[:7])
                    connection.sendall(packet[7:])
                    stop.wait(4)

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            source = f'bambu://bblp:native-secret@127.0.0.1:{listener.getsockname()[1]}/live'
            relay = JpegRelay(replace(Settings(source), reconnect_delay=0.1))
            relay.start()
            try:
                deadline = time.monotonic() + 5
                while relay.status()['state'] != 'live' and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertEqual(relay.status()['state'], 'live')
                self.assertEqual(relay.frame, frame)
                header = struct.unpack('<IIII32s32s', auth[0])
                self.assertEqual(header[:4], (64, 0x3000, 0, 0))
                self.assertEqual(header[4].rstrip(b'\0'), b'bblp')
                self.assertEqual(header[5].rstrip(b'\0'), b'native-secret')
                self.assertNotIn('native-secret', json.dumps(relay.status()))
                relay.request_restart()
            finally:
                relay.close()
                stop.set()
                thread.join(timeout=2)
            self.assertFalse(relay.thread.is_alive())


if __name__ == '__main__':
    unittest.main()
