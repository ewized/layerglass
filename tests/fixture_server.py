"""Real HLS playback fixture; never contacts or authenticates with a printer."""

from dataclasses import replace
from http.server import ThreadingHTTPServer
import hashlib
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app
from cameras import CameraRegistry
from discovery import endpoint
from replay import ReplayBuffer


SOURCE = 'rtsps://bblp:fixture-code@192.168.50.2:322/streaming/live/1'
original_command = app.ffmpeg_command


class FixtureTelemetry:
    def __init__(self, source, saved=None, on_identity=None):
        self.on_identity = on_identity
        self.started_at = time.time()

    def start(self):
        self.on_identity({'name': 'Workshop X2D', 'model': 'N6', 'firmware': '01.01.00.80'})

    def close(self):
        pass

    def status(self):
        result = {'connection': 'connected', 'model': 'Bambu Lab X2D', 'firmware': '01.01.00.80',
                'print_state': 'RUNNING', 'progress': 42, 'remaining_minutes': 83, 'layer': 21,
                'total_layers': 50, 'nozzle': 210, 'nozzle_target': 215, 'bed': 60,
                'bed_target': 60, 'wifi': '-45dBm', 'job': 'Fixture print', 'error': 0}
        if os.environ.get('FIXTURE_TELEMETRY') == '1':
            elapsed = max(0, int(time.time() - self.started_at))
            result.update(updated_at=time.time(), layer=elapsed, progress=elapsed % 100,
                          nozzle=200 + elapsed % 25, remaining_minutes=1000 - elapsed)
            result['reported'] = {'print': {'layer_num': elapsed, 'mc_percent': elapsed % 100,
                'ams': {'humidity': 40 + elapsed % 25, 'tray': [{'id': '0', 'tray_type': 'PLA', 'enabled': False}]},
                'new_sensor': {'total': elapsed, 'coefficient': 0.00000321}},
                'info': {'module': [{'name': 'ota', 'hw_ver': 'AP07', 'sw_ver': '01.01.00.80'}]}}
        if os.environ.get('FIXTURE_DUAL_TELEMETRY') == '1':
            elapsed = max(0, int(time.time() - self.started_at))
            result.update(nozzle_count=2, nozzle_1=200 + elapsed % 25, nozzle_1_target=215,
                          nozzle_2=40 + elapsed % 25, nozzle_2_target=25, active_nozzle=1,
                          elapsed_seconds=3600 + elapsed, elapsed_source='printer', chamber=34,
                          chamber_target=0, speed_mode='Standard', speed_percent=100,
                          part_fan=100, aux_fan=0, exhaust_fan=20, heatbreak_fan=100)
        return result


def fixture_command(settings, directory):
    command = original_command(settings, directory)
    return ['ffmpeg', '-hide_banner', '-nostdin', '-loglevel', 'warning', '-re',
            '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15',
            *command[command.index('-map'):]]


app.ffmpeg_command = fixture_command
os.environ['CAMERA_DATA_DIR'] = '/tmp/fixture-settings'
os.environ['DISCOVERY_CIDRS'] = '192.168.50.0/24'
settings = replace(app.Settings(SOURCE), stream_mode='transcode', reconnect_delay=0.1)
registry = CameraRegistry(settings, app.Relay, telemetry_factory=FixtureTelemetry)
registry.discovery.found = [dict(endpoint(SOURCE, provider='bambu'), name='Workshop X2D', model='N6', serial='20P000000000001'),
                            dict(endpoint('rtsps://192.168.50.3:322/streaming/live/1', provider='bambu'), name='Studio X1', model='BL-P001', serial='00M000000000002')]
if os.environ.get('FIXTURE_GENERIC') == '1':
    for offset in (0, 1):
        registry.discovery.found.extend([
            dict(endpoint(f'rtsp://192.168.50.{8 + offset}:8554/'), name=f'Generic RTSP {offset}'),
            dict(endpoint(f'http://192.168.50.{10 + offset}:8080/'), name=f'Generic HTTP {offset}',
                 path='/stream', setup={'type': 'connection', 'path': '/stream'}),
        ])
registry.discovery.state = 'done'
registry.discovery.start = lambda: False
registry.start()
replay = ReplayBuffer(registry, root='/tmp/fixture-buffer')
replay.start()


class FixtureHandler(app.ViewerHandler):
    pwa_release = 0
    broken_shell = False
    network_unavailable = False
    rejected_video_viewers = set()

    def _get(self, head=False):
        if self.network_unavailable:
            return self._json(503, {'error': 'Fixture network unavailable'}, head)
        if self.broken_shell and self.path == '/static/icons/icon-192.png':
            return self._json(503, {'error': 'Fixture interrupted deployment'}, head)
        if (re.fullmatch(r'/replay/[a-f0-9]{32}/video', urlsplit(self.path).path) and
                self.headers.get('X-Fixture-Stream-Viewer') in self.rejected_video_viewers):
            return self._json(503, {'error': 'Fixture rejected video stream'}, head)
        return super()._get(head)

    def do_POST(self):
        parsed = urlsplit(self.path)
        if parsed.path == '/__fixture/video-stream':
            query = parse_qs(parsed.query)
            viewer = query.get('viewer', [''])[0]
            if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', viewer):
                return self._json(400, {'error': 'Invalid fixture viewer'})
            if query.get('blocked') == ['1']:
                self.rejected_video_viewers.add(viewer)
            else:
                self.rejected_video_viewers.discard(viewer)
            return self._json(200, {'blocked': viewer in self.rejected_video_viewers})
        if os.environ.get('FIXTURE_PWA') == '1' and parsed.path == '/__fixture/pwa-network':
            FixtureHandler.network_unavailable = parse_qs(parsed.query).get('offline') == ['1']
            return self._json(200, {'offline': self.network_unavailable})
        if self.network_unavailable:
            return self._json(503, {'error': 'Fixture network unavailable'})
        if os.environ.get('FIXTURE_PWA') == '1' and parsed.path == '/__fixture/pwa-update':
            FixtureHandler.pwa_release += 1
            FixtureHandler.broken_shell = parse_qs(parsed.query).get('fail') == ['1']
            if 'cache' in parse_qs(parsed.query):
                app.PWA_CACHE_ENABLED = parse_qs(parsed.query)['cache'] == ['1']
            app.APP_SHELL_REVISION = hashlib.sha256(f'fixture-{self.pwa_release}'.encode()).hexdigest()[:24]
            return self._json(200, {'revision': app.APP_SHELL_REVISION})
        return super().do_POST()


server = app.ViewerServer(('0.0.0.0', 8080), registry=registry, replay=replay)
server.RequestHandlerClass = FixtureHandler
try:
    server.serve_forever()
finally:
    server.server_close()
    replay.close()
    registry.close()
