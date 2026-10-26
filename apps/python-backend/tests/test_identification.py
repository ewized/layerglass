"""Credential-free identity evidence, racing checks, and model/stream admission."""

from concurrent.futures import ThreadPoolExecutor
import ssl
import threading
import unittest
from unittest.mock import Mock, patch

from discovery import Discovery
from providers import BY_ID, approved_camera, endpoint
from providers.bambu.identification import mqtt_identity, tls_context, verified_identity
from providers.identification import IdentificationRace, IdentityCheck


IDENTITY = {'provider': 'bambu', 'serial': '20P000000000001', 'model': 'N6', 'identification': 'mqtt'}


class FakeMqtt:
    """Deliver a TLS socket and one real-shaped CONNACK, without a broker."""
    def __init__(self, serial='20P000000000001', acknowledged=True, reason=135):
        self.connection = Mock()
        self.connection.getpeercert.return_value = {'subject': ((('commonName', serial),),)}
        self.acknowledged, self.reason = acknowledged, reason
        self.connects = []
        self.disconnected = False

    def tls_set_context(self, context):
        self.context = context

    def tls_insecure_set(self, value):
        self.hostname_check_disabled = value

    def connect(self, *args, **kwargs):
        self.connects.append((args, kwargs))
        self.on_socket_open(self, None, self.connection)

    def loop(self, **kwargs):
        if self.acknowledged:
            self.on_connect(self, None, {}, self.reason, None)
        return 5 if self.reason else 0

    def disconnect(self):
        self.disconnected = True

    def socket(self):
        return self.connection


class IdentityTests(unittest.TestCase):
    def test_tls_identity_requires_the_manufacturer_ca_and_an_approved_model(self):
        context = tls_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertFalse(context.check_hostname, 'The verified serial certificate is addressed by its IP.')
        for serial, expected in [('20P000000000001', 'N6'), ('01P000000000001', 'C12'),
                                 ('35F000000000001', None), ('26A000000000001', None),
                                 ('broker.example', None), ('', None)]:
            with self.subTest(serial=serial):
                connection = Mock()
                connection.getpeercert.return_value = {'subject': ((('commonName', serial),),)}
                values = verified_identity(connection, 'mqtt')
                self.assertEqual(values['model'] if values else None, expected)

    def test_mqtt_connack_including_auth_refusal_identifies_without_an_access_code(self):
        for reason in (0, 135):
            with self.subTest(reason=reason):
                client = FakeMqtt(reason=reason)
                factory = Mock(return_value=client)
                values = mqtt_identity('192.168.50.2', threading.Event(), factory)
                self.assertEqual(values, IDENTITY)
                self.assertEqual(client.connects, [(('192.168.50.2', 8883), {'keepalive': 5})])
                self.assertEqual(client.context.verify_mode, ssl.CERT_REQUIRED)
                self.assertFalse(factory.call_args.kwargs['reconnect_on_failure'])
                # The fake deliberately has no credential, publish, subscribe,
                # or loop_start methods: invoking any of them fails the test.
                self.assertTrue(client.disconnected)
                client.connection.close.assert_called_once()

    def test_a_tls_socket_without_a_mqtt_response_does_not_identify_a_printer(self):
        client = FakeMqtt(acknowledged=False)
        self.assertIsNone(mqtt_identity('192.168.50.2', threading.Event(), lambda *_a, **_k: client))
        self.assertTrue(client.disconnected)
        client.connection.close.assert_called_once()

    def test_unknown_or_unapproved_mqtt_identity_is_rejected_and_closed(self):
        for serial in ('35F000000000001', 'broker.example'):
            with self.subTest(serial=serial):
                client = FakeMqtt(serial=serial)
                with self.assertRaises(ssl.SSLError):
                    mqtt_identity('192.168.50.2', threading.Event(), lambda *_a, **_k: client)
                self.assertTrue(client.disconnected)
                client.connection.close.assert_called_once()

    def test_cancelled_scan_does_not_open_a_mqtt_connection(self):
        stop = threading.Event()
        stop.set()
        factory = Mock()
        self.assertIsNone(mqtt_identity('192.168.50.2', stop, factory))
        factory.assert_not_called()


class RaceTests(unittest.TestCase):
    def race(self, checks):
        adapter = Mock(wraps=BY_ID['bambu'])
        adapter.id = 'bambu'
        adapter.identifiers.return_value = checks
        race = IdentificationRace((adapter,), threading.Event())
        self.addCleanup(race.close)
        return race, adapter

    def test_first_approved_result_wins_while_slow_check_is_still_pending(self):
        started, release = threading.Event(), threading.Event()
        def slow():
            started.set()
            release.wait(3)
            return None
        def fast():
            started.wait(1)
            return dict(IDENTITY)
        checks = (Mock(side_effect=slow), Mock(side_effect=fast))
        race, adapter = self.race(checks)
        try:
            with ThreadPoolExecutor(max_workers=2) as callers:
                first = callers.submit(race.identify, '192.168.50.2', 322)
                second = callers.submit(race.identify, '192.168.50.2', 6000)
                self.assertEqual(first.result(timeout=1), IDENTITY)
                self.assertEqual(second.result(timeout=1), IDENTITY)
            self.assertFalse(release.is_set())
            self.assertEqual(race.identify('192.168.50.2', 322), IDENTITY)
            self.assertLessEqual(adapter.identifiers.call_count, 2)
            for check in checks:
                check.assert_called_once()
        finally:
            release.set()

    def test_unapproved_fast_result_or_failed_check_cannot_win_the_race(self):
        def failed():
            raise ssl.SSLError('Certificate verification failed')
        race, _adapter = self.race((lambda: dict(IDENTITY, model='N8', serial='35F000000000001'),
                                   failed, lambda: dict(IDENTITY)))
        self.assertEqual(race.identify('192.168.50.2', 322), IDENTITY)

    def test_failed_identification_is_cached_only_for_this_scan(self):
        check = Mock(return_value=None)
        race, adapter = self.race((check,))
        self.assertIsNone(race.identify('192.168.50.2', 322))
        self.assertIsNone(race.identify('192.168.50.2', 6000))
        self.assertEqual(adapter.identifiers.call_count, 2)
        check.assert_called_once()
        self.assertIsNone(race.identify('192.168.50.2', 322))
        self.assertEqual(adapter.identifiers.call_count, 2)
        another = IdentificationRace((adapter,), threading.Event())
        try:
            self.assertIsNone(another.identify('192.168.50.2', 322))
            self.assertEqual(check.call_count, 2)
        finally:
            another.close()

    def test_failed_control_port_cannot_hide_a_valid_camera_on_the_same_host(self):
        adapter = Mock(wraps=BY_ID['bambu'])
        adapter.id = 'bambu'
        mqtt = Mock(return_value=None)
        camera = {6000: Mock(return_value=None), 322: Mock(return_value=dict(IDENTITY, identification='camera-tls'))}
        adapter.identifiers.side_effect = lambda host, port, stop: (
            IdentityCheck('mqtt', mqtt), IdentityCheck('camera-tls', camera[port], per_port=True))
        race = IdentificationRace((adapter,), threading.Event())
        self.addCleanup(race.close)
        self.assertIsNone(race.identify('192.168.50.2', 6000))
        result = race.identify('192.168.50.2', 322)
        self.assertEqual(result['model'], 'N6')
        self.assertEqual(result['identification'], 'camera-tls')
        self.assertEqual(race.identify('192.168.50.2', 6000), result, 'Positive identity stays shared by host.')
        mqtt.assert_called_once()
        for check in camera.values():
            check.assert_called_once()

    def test_concurrent_camera_ports_share_one_mqtt_connection(self):
        adapter = Mock(wraps=BY_ID['bambu'])
        adapter.id = 'bambu'
        entered, release = threading.Event(), threading.Event()

        def mqtt_check():
            entered.set()
            release.wait(3)
            return None

        mqtt = Mock(side_effect=mqtt_check)
        adapter.identifiers.side_effect = lambda host, port, stop: (
            IdentityCheck('mqtt', mqtt), IdentityCheck('camera-tls', lambda: dict(IDENTITY) if port == 322 else None, per_port=True))
        race = IdentificationRace((adapter,), threading.Event())
        self.addCleanup(race.close)
        try:
            with ThreadPoolExecutor(max_workers=2) as callers:
                control = callers.submit(race.identify, '192.168.50.2', 6000)
                self.assertTrue(entered.wait(1))
                camera = callers.submit(race.identify, '192.168.50.2', 322)
                self.assertEqual(camera.result(timeout=1), IDENTITY)
                self.assertFalse(release.is_set(), 'An approved camera must not wait for MQTT.')
                release.set()
                self.assertEqual(control.result(timeout=1), IDENTITY)
        finally:
            release.set()
        mqtt.assert_called_once()


class AdmissionTests(unittest.TestCase):
    def test_open_camera_ports_without_verified_manufacturer_identity_are_hidden(self):
        scanner = Discovery()
        scanner.identifier = Mock()
        scanner.identifier.identify.return_value = None
        # A plausible model and friendly name on an unverified camera TLS
        # certificate must not bypass the separate identification race.
        candidate = dict(endpoint('rtsps://192.168.50.2:322/'), model='N6', name='Printer')
        with patch('discovery.probe', return_value=candidate):
            self.assertIsNone(scanner._probe('192.168.50.2', 322, 'rtsps'))

    def test_only_the_verified_models_approved_protocol_is_admitted(self):
        scanner = Discovery()
        scanner.identifier = Mock()
        for model, protocol in [('N6', 'rtsps'), ('C12', 'bambu')]:
            scanner.identifier.identify.return_value = dict(IDENTITY, model=model)
            for port, kind in ((322, 'rtsps'), (6000, 'bambu')):
                with self.subTest(model=model, port=port), patch('discovery.probe',
                        return_value=endpoint(f'{kind}://192.168.50.2:{port}/')):
                    item = scanner._probe('192.168.50.2', port, kind)
                    self.assertEqual(item is not None, protocol == kind)
                    if item:
                        self.assertTrue(approved_camera(item))
                        self.assertEqual(item['provider'], 'bambu')
                        self.assertEqual(item['identification'], 'mqtt')

    def test_generic_ports_and_mqtt_port_are_never_camera_candidates(self):
        scanner = Discovery()
        with patch('discovery.probe') as raw:
            for port, kind in ((554, 'rtsp'), (8080, 'http'), (8883, 'rtsps'), (322, 'rtsp')):
                self.assertIsNone(scanner._probe('192.168.50.2', port, kind))
            raw.assert_not_called()

    def test_ssdp_enriches_names_without_overriding_verified_model_and_serial(self):
        scanner = Discovery('', '192.168.50.2/32')
        item = dict(endpoint('rtsps://192.168.50.2:322/', provider='bambu'), **IDENTITY)
        with patch.object(scanner, '_probe', side_effect=lambda _h, p, _k: item if p == 322 else None), \
             patch('discovery.discover_names', return_value={'192.168.50.2':
                   {'name': 'Workshop', 'model': 'C12', 'serial': '01P000000000001'}}):
            scanner.start()
            scanner.thread.join(3)
        self.addCleanup(scanner.close)
        result = scanner.status()['found'][0]
        self.assertEqual(result['name'], 'Workshop')
        self.assertEqual(result['model'], 'N6')
        self.assertEqual(result['serial'], IDENTITY['serial'])
