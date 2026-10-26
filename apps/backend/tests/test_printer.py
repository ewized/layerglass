import ipaddress
import json
import ssl
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from providers.bambu.announcements import parse_announcement
from providers.bambu.telemetry import PrinterTelemetry, camera_protocol, certificate_identity, display_name, model_name


SOURCE = 'rtsps://bblp:private-code@192.168.50.2:322/streaming/live/1'
SERIAL = '20P000000000001'


class Client:
    def __init__(self, version):
        self.published = []
        self.subscriptions = []
        self.stopped = False

    def username_pw_set(self, username, code):
        self.username, self.code = username, code

    def tls_set_context(self, context):
        self.context = context

    def tls_insecure_set(self, value):
        self.hostname_check_disabled = value

    def reconnect_delay_set(self, **values):
        self.reconnect = values

    def connect_async(self, host, port, **values):
        self.address = host, port

    def loop_start(self):
        pass

    def disconnect(self):
        self.stopped = True

    def loop_stop(self):
        pass

    def subscribe(self, topic, **values):
        self.subscriptions.append(topic)

    def publish(self, topic, payload, **values):
        self.published.append((topic, json.loads(payload)))


class PrinterTests(unittest.TestCase):
    def setUp(self):
        self.identities = []
        self.printer = PrinterTelemetry(SOURCE, client_factory=Client, on_identity=self.identities.append)
        self.printer.start()
        self.client = self.printer.client
        self.client.on_socket_open(self.client, None, SimpleNamespace(getpeercert=lambda: {'subject': ((('commonName', SERIAL),),)}))
        self.client.on_connect(self.client, None, None, 0, None)
        self.addCleanup(self.printer.close)

    def send(self, data, topic=None):
        self.client.on_message(self.client, None, SimpleNamespace(topic=topic or f'device/{SERIAL}/report', payload=json.dumps(data).encode()))

    def test_verified_tls_shared_credentials_and_report_subscription(self):
        self.assertEqual(self.client.context.verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(self.client.username, 'bblp')
        self.assertEqual(self.client.code, 'private-code')
        self.assertEqual(self.client.address, ('192.168.50.2', 8883))
        self.assertEqual(self.client.subscriptions, [f'device/{SERIAL}/report'])
        self.assertEqual(self.printer.status()['model'], 'Bambu Lab X2D')
        self.assertNotIn('private-code', json.dumps(self.printer.status()))

    def test_only_initial_read_queries_are_sent_and_reconnects_do_not_poll(self):
        reasons = [SimpleNamespace(is_failure=False)]
        with patch('providers.bambu.telemetry.time.monotonic', return_value=0):
            self.client.on_subscribe(self.client, None, 1, reasons, None)
        with patch('providers.bambu.telemetry.time.monotonic', return_value=299):
            for _ in range(100):
                self.client.on_subscribe(self.client, None, 2, reasons, None)
        self.assertEqual(len(self.client.published), 2)
        self.assertEqual({next(iter(body)) for _, body in self.client.published}, {'info', 'pushing'})
        self.assertEqual({part['command'] for _, body in self.client.published for part in body.values()}, {'get_version', 'pushall'})
        with patch('providers.bambu.telemetry.time.monotonic', return_value=300):
            self.client.on_subscribe(self.client, None, 3, reasons, None)
        self.assertEqual(len(self.client.published), 4)

    def test_delta_reports_preserve_unchanged_fields_and_zero_is_a_real_value(self):
        self.send({'print': {'gcode_state': 'RUNNING', 'mc_percent': 42, 'bed_temper': 60,
                             'nozzle_temper': 200, 'layer_num': 21, 'access_code': 'never-expose',
                             'ipcam': {'rtsp_url': SOURCE}, 'subtask_name': 'Bracket'}})
        self.send({'print': {'mc_percent': 0, 'nozzle_temper': 205}})
        status = self.printer.status()
        self.assertEqual(status['progress'], 0)
        self.assertEqual(status['bed'], 60)
        self.assertEqual(status['layer'], 21)
        self.assertEqual(status['nozzle'], 205)
        self.assertEqual(status['job'], 'Bracket')
        self.assertEqual(status['print_state'], 'RUNNING')
        self.assertNotIn('never-expose', json.dumps(status))
        self.assertNotIn('rtsps://', json.dumps(status))
        self.send({'print': {'mc_percent': -1, 'bed_temper': float('nan'), 'layer_num': True}})
        self.assertEqual(self.printer.status()['progress'], 0)
        self.assertEqual(self.printer.status()['bed'], 60)
        self.send({'print': {'subtask_name': ''}})
        self.assertIsNone(self.printer.status()['job'])

    def test_dual_nozzles_use_ids_and_preserve_independent_partial_readings(self):
        self.send({'print': {'nozzle_temper': 999, 'device': {'extruder': {'state': 0x12, 'info': [
            {'id': 1, 'temp': (25 << 16) | 46}, {'id': 0, 'temp': (215 << 16) | 210},
        ]}}}})
        status = self.printer.status()
        self.assertEqual((status['nozzle_1'], status['nozzle_1_target']), (210, 215))
        self.assertEqual((status['nozzle_2'], status['nozzle_2_target']), (46, 25))
        self.assertEqual((status['nozzle_count'], status['active_nozzle']), (2, 2))
        self.send({'print': {'device': {'extruder': {'info': [{'id': 0, 'temp': 50}]}}}})
        status = self.printer.status()
        self.assertEqual((status['nozzle_1'], status['nozzle_1_target']), (50, 0))
        self.assertEqual((status['nozzle_count'], status['nozzle_2'], status['active_nozzle']), (2, 46, 2))
        self.send({'print': {'device': {'extruder': {'state': 2}}}})
        self.assertEqual(self.printer.status()['active_nozzle'], 1)

    def test_packed_chamber_bed_and_unknown_temperature_sentinels(self):
        self.send({'print': {'device': {
            'ctc': {'info': {'temp': (40 << 16) | 34}},
            'bed': {'info': {'temp': (60 << 16) | 55}},
            'extruder': {'info': [{'id': 1, 'temp': 0xffffffff}, {'id': True, 'temp': 215},
                                  {'id': 0, 'temp': True}, {'id': 50, 'temp': 215}]},
        }}})
        status = self.printer.status()
        self.assertEqual((status['chamber'], status['chamber_target']), (34, 40))
        self.assertEqual((status['bed'], status['bed_target']), (55, 60))
        self.assertEqual(status['nozzle_count'], 2)
        self.assertIsNone(status['nozzle_2'])
        self.assertIsNone(status['nozzle_2_target'])
        self.assertNotIn('nozzle_1', status)
        for device in (None, [], {'extruder': {'info': 'bad'}}, {'ctc': {'info': []}}):
            self.send({'print': {'device': device}})
        self.assertEqual(self.printer.status()['chamber'], 34)

    def test_fans_and_print_speed_have_validated_public_units(self):
        self.send({'print': {'fan_gear': 64 | (128 << 8) | (255 << 16) | (255 << 24), 'heatbreak_fan_speed': '15',
                             'spd_lvl': 2, 'spd_mag': 100}})
        status = self.printer.status()
        self.assertEqual((status['part_fan'], status['aux_fan'], status['exhaust_fan'], status['heatbreak_fan']),
                         (25.1, 50.2, 100, 100))
        self.assertEqual((status['speed_mode'], status['speed_percent']), ('Standard', 100))
        self.send({'print': {'fan_gear': 0, 'heatbreak_fan_speed': '0'}})
        self.assertEqual(self.printer.status()['part_fan'], 0)
        self.send({'print': {'cooling_fan_speed': '7.5', 'big_fan1_speed': '15', 'big_fan2_speed': '0'}})
        status = self.printer.status()
        self.assertEqual((status['part_fan'], status['aux_fan'], status['exhaust_fan']), (50, 100, 0))
        self.send({'print': {'fan_gear': -1, 'cooling_fan_speed': 16, 'spd_lvl': True, 'spd_mag': float('nan')}})
        self.assertEqual((self.printer.status()['speed_mode'], self.printer.status()['part_fan']), ('Standard', 50))

    def test_elapsed_uses_reported_start_and_holds_the_observed_completion(self):
        epoch = 1700000000
        with patch('providers.bambu.telemetry.time.time', return_value=epoch + 100):
            self.send({'print': {'gcode_state': 'RUNNING', 'gcode_start_time': str(epoch)}})
            self.assertEqual(self.printer.status()['elapsed_seconds'], 100)
            self.assertEqual(self.printer.status()['elapsed_source'], 'printer')
        with patch('providers.bambu.telemetry.time.time', return_value=epoch + 150):
            self.send({'print': {'gcode_state': 'PAUSE'}})
            self.assertEqual(self.printer.status()['elapsed_seconds'], 150)
        with patch('providers.bambu.telemetry.time.time', return_value=epoch + 180):
            self.send({'print': {'gcode_state': 'FINISH'}})
        with patch('providers.bambu.telemetry.time.time', return_value=epoch + 10000):
            self.assertEqual(self.printer.status()['elapsed_seconds'], 180)

    def test_joining_running_jobs_never_invents_elapsed_and_new_starts_are_observed(self):
        epoch = 1700000000
        with patch('providers.bambu.telemetry.time.time', return_value=epoch):
            self.send({'print': {'gcode_state': 'RUNNING', 'mc_percent': 50, 'mc_remaining_time': 60}})
            self.assertIsNone(self.printer.status()['elapsed_seconds'])
            for invalid in ('0', 'nan', 'inf', -1, epoch + 100, True):
                self.send({'print': {'gcode_start_time': invalid}})
                self.assertIsNone(self.printer.status()['elapsed_seconds'])
            self.send({'print': {'gcode_state': 'FINISH'}})
        with patch('providers.bambu.telemetry.time.time', return_value=epoch + 10):
            self.send({'print': {'gcode_state': 'PREPARE', 'subtask_id': 'first'}})
        with patch('providers.bambu.telemetry.time.time', return_value=epoch + 20):
            self.send({'print': {'gcode_state': 'RUNNING', 'task_id': 'separate-id'}})
            self.assertEqual(self.printer.status()['elapsed_seconds'], 10)
            self.assertEqual(self.printer.status()['elapsed_source'], 'observed')
            self.send({'print': {'subtask_id': 'first'}})
            self.assertEqual(self.printer.status()['elapsed_seconds'], 10)
            self.send({'print': {'subtask_id': 'another-job'}})
            self.assertIsNone(self.printer.status()['elapsed_seconds'])
            self.assertEqual(self.printer.status()['reported']['print']['subtask_id'], 'another-job')

    def test_all_native_stats_are_public_and_nested_deltas_are_immutable(self):
        self.send({'print': {'ams': {'ams': [{'id': '0', 'humidity': 4, 'tray': [{'id': '1', 'tray_type': 'PLA'}]}]},
                             'new_sensor': {'value': 3, 'ready': False},
                             'device': {'extruder': {'info': [{'id': 0, 'temp': 210}, {'id': 1, 'temp': 30}]}}},
                   'info': {'module': [{'name': 'mc', 'hw_ver': 'AP01', 'sw_ver': '01.02'}]}})
        before = self.printer.status()
        self.send({'print': {'new_sensor': {'value': 4},
                             'device': {'extruder': {'info': [{'id': 1, 'temp': 31}]}}}})
        after = self.printer.status()
        self.assertEqual(after['reported']['print']['new_sensor'], {'value': 4, 'ready': False})
        self.assertEqual(after['reported']['print']['device']['extruder']['info'], [{'id': 0, 'temp': 210}, {'id': 1, 'temp': 31}])
        self.assertEqual(after['reported']['info']['module'][0]['hw_ver'], 'AP01')
        self.assertEqual(before['reported']['print']['new_sensor']['value'], 3)
        after['reported']['print']['ams']['ams'][0]['humidity'] = 999
        self.assertEqual(self.printer.status()['reported']['print']['ams']['ams'][0]['humidity'], 4)

    def test_firmware_identity_updates_are_deltas_and_never_replace_a_discovered_name(self):
        self.printer.identity['name'] = 'Older name'
        self.send({'info': {'module': [{'name': 'ota', 'sw_ver': '01.02.03.04'}, {'name': 'mc', 'sw_ver': 'other'}]}})
        self.assertEqual(self.printer.status()['firmware'], '01.02.03.04')
        self.assertEqual(self.identities[-1], {'firmware': '01.02.03.04'})
        self.send({'print': {'device': {'name': 'Enclosure printer'}}})
        self.assertEqual(self.identities[-1], {'name': 'Enclosure printer'})

    def test_display_identity_is_redacted_before_callback_and_truncation(self):
        reports = [
            {'print': {'dev_name': 'Printer private-code ' + SOURCE}},
            {'print': {'device': {'name': 'Printer ' + SOURCE}}},
            {'info': {'device_name': 'Printer private-code'}},
            {'info': {'module': [{'name': 'ota', 'sw_ver': 'Version private-code ' + SOURCE}]}},
        ]
        for report in reports:
            with self.subTest(report=report):
                self.send(report)
                encoded = json.dumps([self.identities[-1], self.printer.identity, self.printer.status()])
                self.assertNotIn('private-code', encoded)
                self.assertNotIn('rtsps://', encoded)
                self.assertIn('[redacted]', encoded)
        self.send({'print': {'dev_name': 'x' * 124 + 'private-code'}})
        self.assertEqual(self.identities[-1]['name'], 'x' * 124 + '[red')
        self.assertEqual(self.printer.identity['serial'], SERIAL)

    def test_short_codes_do_not_redact_private_tls_or_topic_identity(self):
        updates = []
        printer = PrinterTelemetry(SOURCE.replace('private-code', '2'),
                                   saved={'model': 'N6', 'serial': SERIAL},
                                   on_identity=updates.append, client_factory=Client)
        self.addCleanup(printer.close)
        printer.start()
        connection = SimpleNamespace(getpeercert=lambda: {'subject': ((('commonName', SERIAL),),)})
        printer.client.on_socket_open(printer.client, None, connection)
        printer._identity({'name': 'Room 2', 'firmware': '2.0'})
        printer.client.on_connect(printer.client, None, None, 0, None)
        self.assertEqual(printer.identity['serial'], SERIAL)
        self.assertEqual(printer.identity['model'], 'N6')
        self.assertEqual(updates[-1], {'name': 'Room [redacted]', 'firmware': '[redacted].0'})
        self.assertEqual(printer.client.subscriptions, [f'device/{SERIAL}/report'])
        wrong = SimpleNamespace(getpeercert=lambda: {'subject': ((('commonName', '20P000000000002'),),)})
        with self.assertRaises(ssl.SSLError):
            printer.client.on_socket_open(printer.client, None, wrong)

    def test_wrong_topics_and_malformed_or_oversized_messages_are_ignored(self):
        self.send({'print': {'mc_percent': 99}}, 'device/another-printer/report')
        self.send([])
        self.send({'print': 'invalid', 'info': {'module': {}}})
        for payload in (b'bad-json', b'x' * (512 * 1024 + 1), b'[' * 2000):
            self.client.on_message(self.client, None, SimpleNamespace(topic=f'device/{SERIAL}/report', payload=payload))
        self.assertNotIn('progress', self.printer.status())

    def test_lost_or_stale_telemetry_preserves_last_values_and_close_ignores_late_reports(self):
        with patch('providers.bambu.telemetry.time.time', return_value=1000):
            self.send({'print': {'bed_temper': 60}})
        with patch('providers.bambu.telemetry.time.time', return_value=1061):
            self.assertEqual(self.printer.status()['connection'], 'stale')
        self.client.on_disconnect(self.client, None, None, 1, None)
        self.assertEqual(self.printer.status()['connection'], 'reconnecting')
        self.assertEqual(self.printer.status()['bed'], 60)
        self.printer.close()
        self.send({'print': {'bed_temper': 90}})
        self.assertEqual(self.printer.status()['bed'], 60)
        self.assertEqual(self.printer.status()['connection'], 'stopped')
        self.assertTrue(self.client.stopped)
        self.client.on_subscribe(self.client, None, 1, [SimpleNamespace(is_failure=False)], None)
        self.assertEqual(self.client.published, [])

    def test_mismatched_certificate_is_rejected_and_connection_errors_remain_visible(self):
        connection = SimpleNamespace(getpeercert=lambda: {'subject': ((('commonName', 'OTHER000000001'),),)})
        with self.assertRaises(ssl.SSLError):
            self.client.on_socket_open(self.client, None, connection)
        self.client.on_connect_fail(self.client, None)
        self.assertEqual(self.printer.status()['connection'], 'certificate_error')

    def test_no_access_code_never_connects_to_mqtt(self):
        printer = PrinterTelemetry('rtsps://192.168.50.2:322/live', client_factory=Client)
        printer.start()
        self.assertIsNone(printer.client)
        self.assertEqual(printer.status()['connection'], 'access_code_required')

    def test_labels_prefer_names_then_serials_then_camera_ids(self):
        host = '192.168.50.2'
        key = '0123456789abcdef'
        self.assertEqual(display_name({'name': 'Print room', 'serial': SERIAL}, host, key), 'Print room')
        self.assertEqual(display_name({'serial': SERIAL}, host, key), SERIAL)
        self.assertEqual(display_name({'name': '  ', 'serial': SERIAL}, host, key), SERIAL)
        self.assertEqual(display_name({'name': host, 'serial': SERIAL}, host, key), SERIAL)
        for values in ({'model': 'N6'}, {'name': '  '}, {'name': host}, {'serial': 'invalid!'}, {}):
            with self.subTest(values=values):
                self.assertEqual(display_name(values, host, key), 'Camera 01234567')

    def test_model_identity_selects_the_camera_protocol(self):
        self.assertEqual(model_name('N6'), 'Bambu Lab X2D')
        self.assertEqual(camera_protocol({'serial': SERIAL}), 'rtsps')
        self.assertEqual(camera_protocol({'model': 'C12'}), 'bambu')
        self.assertIsNone(camera_protocol({}))

    def test_discovery_reads_only_the_public_certificate_for_model_identification(self):
        connection = SimpleNamespace(getpeercert=lambda **_kwargs: b'public-der')
        with patch('providers.bambu.telemetry.subprocess.run', return_value=SimpleNamespace(stdout=f'subject=CN={SERIAL}\n'.encode())) as process:
            self.assertEqual(certificate_identity(connection), {'serial': SERIAL})
        self.assertEqual(process.call_args.kwargs['input'], b'public-der')


class AnnouncementTests(unittest.TestCase):
    def setUp(self):
        self.networks = [ipaddress.ip_network('192.168.50.0/24')]
        self.packet = ('NOTIFY * HTTP/1.1\r\nNT: urn:bambulab-com:device:3dprinter:1\r\n'
                       'Location: 192.168.50.2\r\nDevName.bambu.com: 工房 printer\r\n'
                       f'DevModel.bambu.com: N6\r\nUSN: {SERIAL}\r\n\r\n').encode()

    def test_utf8_advertisement_supplies_name_model_and_serial(self):
        self.assertEqual(parse_announcement(self.packet, '192.168.50.2', self.networks),
                         {'name': '工房 printer', 'model': 'N6', 'serial': SERIAL})

    def test_outside_subnet_spoofed_locations_and_unrelated_or_oversized_packets_are_rejected(self):
        for packet, peer in ((self.packet, '192.168.4.2'), (self.packet, '192.168.50.3'),
                             (self.packet.replace(b'3dprinter:1', b'other:1'), '192.168.50.2'),
                             (b'x' * 8193, '192.168.50.2'), (b'\xff', '192.168.50.2')):
            self.assertIsNone(parse_announcement(packet, peer, self.networks))


if __name__ == '__main__':
    unittest.main()
