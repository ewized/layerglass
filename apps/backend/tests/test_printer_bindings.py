"""Synthetic printer replacement and credential-binding lifecycle regressions."""

from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from app import Settings
from cameras import CameraRegistry
from providers import endpoint
from test_cameras import FakeRelay, FakeTelemetry


SOURCE = 'rtsps://bblp:code-a@192.168.50.2:322/streaming/live/1'
SERIAL_A = '20P000000000001'
SERIAL_B = '20P000000000002'


class PrinterBindingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        environment = patch.dict(os.environ, {'CAMERA_DATA_DIR': str(self.root), 'DISCOVERY_CIDRS': ''})
        environment.start()
        self.addCleanup(environment.stop)
        native = patch('providers.bambu.JpegRelay', FakeRelay)
        native.start()
        self.addCleanup(native.stop)
        self.registry = self.registry_for()
        self.key = endpoint(SOURCE)['id']
        self.discover(self.printer())
        self.registry.configure(self.key, 'code-a')

    def registry_for(self, source=SOURCE):
        registry = CameraRegistry(Settings(source), FakeRelay, telemetry_factory=FakeTelemetry)
        self.addCleanup(registry.close)
        return registry

    @staticmethod
    def printer(source=SOURCE, serial=SERIAL_A, model='N6', name='Printer A'):
        return dict(endpoint(source, provider='bambu'), serial=serial, model=model,
                    name=name, identification='mqtt')

    def discover(self, *items, finish=True):
        self.registry.discovery.found = list(items)
        if finish:
            self.registry.discovery.finished_at = (self.registry.discovery.finished_at or 0) + 1
        return self.registry.catalog()

    def replace(self, finish=True):
        return self.discover(self.printer(serial=SERIAL_B, name='Replacement'), finish=finish)

    def stored(self):
        return json.loads(self.registry.store.read_text())

    def test_replacement_quarantines_private_binding_and_requires_explicit_pairing_after_reload(self):
        second = self.printer(source=SOURCE.replace('.2:', '.3:'), serial='20P000000000003', name='Other printer')
        self.discover(self.printer(), second)
        self.registry.configure(second['id'], 'other-code')
        other_relay = self.registry.get_relay(second['id'])
        other_client = self.registry.get_telemetry(second['id'])
        relay = self.registry.get_relay(self.key)
        client = self.registry.get_telemetry(self.key)
        catalog = self.replace()
        camera = next(item for item in catalog['cameras'] if item['id'] == self.key)
        self.assertFalse(camera['configured'])
        self.assertEqual(camera['serial'], SERIAL_B)
        self.assertTrue(relay.closed)
        self.assertTrue(client.closed)
        self.assertFalse(other_relay.closed)
        self.assertFalse(other_client.closed)
        self.assertIsNone(self.registry.get_relay(self.key))
        self.assertIsNone(self.registry.get_telemetry(self.key))
        self.assertEqual(self.registry.status(self.key)['state'], 'setup')
        saved = self.stored()
        self.assertNotIn(self.key, saved['sources'])
        self.assertEqual(saved['quarantined'][self.key]['source'], SOURCE)
        self.assertEqual(saved['quarantined'][self.key]['identity']['serial'], SERIAL_A)
        self.assertEqual(saved['identities'][self.key]['serial'], SERIAL_B)
        self.assertEqual(self.registry.store.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('code-a', json.dumps(catalog))

        reloaded = self.registry_for()
        self.assertNotIn(self.key, reloaded.sources, 'STREAM_URL must not reactivate a quarantine.')
        self.assertIsNone(reloaded.get_relay(self.key))
        self.assertIsNone(reloaded.get_telemetry(self.key))
        self.assertFalse(next(item for item in reloaded.catalog()['cameras'] if item['id'] == self.key)['configured'])
        reloaded.configure(self.key, 'code-b')
        self.assertNotIn(self.key, reloaded.quarantined)
        self.assertEqual(reloaded.get_telemetry(self.key).saved['serial'], SERIAL_B)
        self.assertIn('code-b', reloaded.sources[self.key])
        self.assertNotIn('code-a', reloaded.store.read_text())
        self.assertEqual(reloaded.sources[second['id']], self.registry.sources[second['id']])

    def test_replacement_is_blocked_before_the_scan_finish_timestamp_changes(self):
        finished = self.registry.discovery.finished_at
        self.registry.discovery.state = 'scanning'
        self.replace(finish=False)
        self.assertEqual(self.registry.discovery.finished_at, finished)
        self.assertNotIn(self.key, self.registry.sources)
        self.assertIsNone(self.registry.get_relay(self.key))

    def test_forgetting_a_quarantine_removes_only_its_private_binding(self):
        second = self.printer(source=SOURCE.replace('.2:', '.3:'), serial='20P000000000003')
        self.discover(self.printer(), second)
        self.registry.configure(second['id'], 'other-code')
        self.replace()
        self.registry.forget(self.key)
        saved = self.stored()
        self.assertNotIn(self.key, saved['quarantined'])
        self.assertNotIn(self.key, saved['identities'])
        self.assertNotIn('code-a', self.registry.store.read_text())
        self.assertIn('other-code', saved['sources'][second['id']])
        self.assertIn(self.key, saved['forgotten'])
        reloaded = self.registry_for()
        self.assertNotIn(self.key, reloaded.sources)
        self.assertEqual(reloaded.status(self.key)['state'], 'empty')

    def test_quarantine_write_failure_is_atomic_and_fails_closed_until_an_explicit_retry(self):
        before = self.registry.store.read_bytes()
        client = self.registry.get_telemetry(self.key)
        with patch('cameras.Path.replace', side_effect=OSError('Synthetic disk unavailable')):
            with self.assertLogs('printer-camera', level='WARNING'):
                self.replace()
        self.assertEqual(self.registry.store.read_bytes(), before)
        self.assertTrue(client.closed)
        self.assertTrue(self.registry.quarantine_unsaved)
        self.assertNotIn(self.key, self.registry.sources)
        self.assertEqual(self.registry.quarantined[self.key]['source'], SOURCE)
        self.assertIsNone(self.registry.get_telemetry(self.key))
        self.replace()
        self.assertFalse(self.registry.quarantine_unsaved)
        self.assertEqual(self.stored()['quarantined'][self.key]['identity']['serial'], SERIAL_A)
        self.assertIsNone(self.registry_for().get_telemetry(self.key))

    def test_failed_configure_or_forget_keeps_the_quarantined_binding(self):
        self.replace()
        before = self.registry.store.read_bytes()
        state = deepcopy((self.registry.sources, self.registry.identities, self.registry.quarantined))
        for mutation in (lambda: self.registry.configure(self.key, 'code-b'), lambda: self.registry.forget(self.key)):
            with self.subTest(mutation=mutation), patch.object(self.registry, '_save', side_effect=OSError('Synthetic failure')):
                with self.assertRaises(OSError):
                    mutation()
            self.assertEqual(self.registry.store.read_bytes(), before)
            self.assertEqual((self.registry.sources, self.registry.identities, self.registry.quarantined), state)
            self.assertIsNone(self.registry.get_telemetry(self.key))

    def test_retirement_releases_registry_lock_and_rejects_late_callbacks_after_same_code_repair(self):
        old = self.registry.get_telemetry(self.key)
        callbacks = []

        def close():
            worker = threading.Thread(target=lambda: (
                old.on_identity({'name': 'Late old printer', 'serial': SERIAL_A}), callbacks.append(True)), daemon=True)
            worker.start()
            worker.join(2)
            self.assertFalse(worker.is_alive(), 'Closing a client must not hold the registry callback lock.')
            old.closed = True

        old.close = close
        self.replace()
        self.assertEqual(callbacks, [True])
        self.assertEqual(self.registry.identities[self.key]['serial'], SERIAL_B)
        self.registry.configure(self.key, 'code-a')
        self.assertEqual(self.registry.sources[self.key], SOURCE, 'The explicit replacement may use the same code.')
        old.on_identity({'name': 'Late after repair', 'serial': SERIAL_A})
        self.assertEqual(self.registry.identities[self.key]['serial'], SERIAL_B)
        self.assertEqual(self.registry.identities[self.key]['name'], 'Replacement')

    def test_old_client_cannot_rename_a_same_code_reconfiguration_or_change_the_pin(self):
        old = self.registry.get_telemetry(self.key)
        self.registry.configure(self.key, 'code-a')
        current = self.registry.get_telemetry(self.key)
        old.on_identity({'name': 'Late previous client'})
        self.assertEqual(self.registry.identities[self.key]['name'], 'Printer A')
        current.on_identity({'serial': SERIAL_B, 'name': 'Unverified replacement'})
        self.assertEqual(self.registry.identities[self.key]['serial'], SERIAL_A)
        self.assertEqual(self.registry.identities[self.key]['name'], 'Printer A')

    def test_unchanged_serial_metadata_and_offline_restart_keep_the_pairing(self):
        client = self.registry.get_telemetry(self.key)
        relay = self.registry.get_relay(self.key)
        self.discover(self.printer(name='Renamed'))
        client.on_identity({'firmware': '01.02.03.04'})
        self.assertEqual(self.registry.sources[self.key], SOURCE)
        self.assertEqual(self.registry.identities[self.key]['name'], 'Renamed')
        self.assertIs(self.registry.get_telemetry(self.key), client)
        self.assertIs(self.registry.get_relay(self.key), relay)
        self.assertFalse(client.closed)
        self.assertEqual(self.registry.quarantined, {})
        reloaded = self.registry_for()
        self.assertEqual(reloaded.default_id, self.key)
        self.assertEqual(reloaded.get_telemetry(self.key).saved['serial'], SERIAL_A)

    def test_quarantined_code_stays_filtered_from_replacement_display_metadata(self):
        self.discover(self.printer(serial=SERIAL_B, name='Printer code-a ' + SOURCE))
        self.assertNotIn('code-a', json.dumps(self.registry.catalog()))
        self.assertNotIn('rtsps://', json.dumps(self.registry.catalog()))
        self.assertNotIn('code-a', self.registry.identities[self.key]['name'])
        self.assertNotIn('code-a', json.dumps(self.registry_for().catalog()))

    def test_short_code_reconfiguration_uses_private_model_and_serial(self):
        source = 'bambu://bblp:1@192.168.50.4:6000/streaming/live/1'
        item = self.printer(source, serial='01P000000000001', model='C12')
        self.discover(item)
        self.registry.configure(item['id'], '1')
        public = next(camera for camera in self.registry.catalog()['cameras'] if camera['id'] == item['id'])
        self.assertIn('[redacted]', public['serial'])
        self.assertIn('[redacted]', public['model'])
        self.registry.configure(item['id'], '1')
        saved = self.registry.get_telemetry(item['id']).saved
        self.assertEqual(saved['serial'], '01P000000000001')
        self.assertEqual(saved['model'], 'C12')
        self.assertNotIn(item['id'], self.registry.quarantined)

    def test_legacy_unpinned_source_waits_for_identity_without_losing_its_code(self):
        self.registry.store.write_text(json.dumps({'version': 3, 'sources': {self.key: SOURCE}, 'identities': {}}))
        legacy = self.registry_for()
        self.assertEqual(legacy.sources[self.key], SOURCE)
        self.assertIsNone(legacy.get_telemetry(self.key))
        legacy.discovery.found = [self.printer(serial=SERIAL_B)]
        legacy.discovery.finished_at = 2
        self.assertTrue(legacy.catalog()['cameras'][0]['configured'])
        self.assertEqual(legacy.get_telemetry(self.key).source, SOURCE)
        self.assertEqual(legacy.quarantined, {})

    def test_different_camera_profile_clears_quarantine_only_on_explicit_replacement_setup(self):
        native_source = 'bambu://bblp:native-code@192.168.50.4:6000/streaming/live/1'
        original = self.printer(native_source, serial='01P000000000001', model='C12')
        self.discover(original)
        self.registry.configure(original['id'], 'native-code')
        replacement_source = 'rtsps://bblp:replacement-code@192.168.50.4:322/streaming/live/1'
        replacement = self.printer(replacement_source, serial='20P000000000004', name='New profile')
        self.discover(replacement)
        self.assertIn(original['id'], self.registry.quarantined)
        self.assertIsNone(self.registry.get_telemetry(original['id']))
        self.registry.configure(replacement['id'], 'replacement-code')
        self.assertNotIn(original['id'], self.registry.quarantined)
        self.assertIn(original['id'], self.registry.forgotten)
        self.assertNotIn('native-code', self.registry.store.read_text())
        self.assertEqual(self.registry.sources[self.key], SOURCE)
        self.assertEqual({item['id'] for item in self.registry.catalog()['cameras']}, {self.key, replacement['id']})
        reloaded = self.registry_for(source=native_source)
        self.assertNotIn(original['id'], reloaded.sources)
        self.assertEqual(reloaded.get_telemetry(replacement['id']).saved['serial'], '20P000000000004')
