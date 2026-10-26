import json
import unittest

from providers.telemetry import MAX_DEPTH, merge_report, public_stats


class PublicTelemetryTests(unittest.TestCase):
    def test_retains_unknown_fields_nested_arrays_false_zero_and_null(self):
        data = {'print': {'mc_percent': 0, 'new_sensor': {'ready': False, 'value': None},
                          'ams': [{'id': '0', 'humidity': 4, 'tray': [{'tray_type': 'PLA'}]}]}}
        self.assertEqual(public_stats(data), data)

    def test_credentials_and_urls_are_removed_recursively(self):
        data = {'accessCode': 'secret', 'password': 'secret', 'mqtt_token': 'secret', 'raw': {'private': 'secret'},
                'print': {'wifiPassword': 'secret', 'source': 'rtsps://bblp:secret@192.168.4.104/live',
                          'note': 'key secret', 'mc_percent': 0, '__proto__': {'polluted': True}}}
        result = public_stats(data, secrets=('secret',))
        encoded = json.dumps(result)
        self.assertNotIn('secret', encoded)
        self.assertNotIn('rtsps://', encoded)
        self.assertNotIn('password', encoded)
        self.assertNotIn('__proto__', encoded)
        self.assertEqual(result['print']['mc_percent'], 0)

    def test_nonfinite_values_are_excluded_and_large_ids_do_not_lose_precision(self):
        result = public_stats({'a': float('nan'), 'b': float('inf'), 'id': 2 ** 64 - 1, 'enabled': False})
        self.assertEqual(result, {'id': str(2 ** 64 - 1), 'enabled': False})
        json.dumps(result, allow_nan=False)

    def test_sensitive_object_keys_are_omitted_before_copying_or_budgeting(self):
        code = '30862741'
        source = f'rtsps://bblp:{code}@192.0.2.1:322/streaming/live/1'
        data = {'readings': {code: 'value', f'sensor_{code}': {'value': 1},
                             source: 'camera', 'https://camera.example/live': 'camera',
                             'safe': [{'id': 0, 'value': False}]}, 'good': 123}
        result = public_stats(data, secrets=('', code))
        self.assertEqual(result, {'readings': {'safe': [{'id': 0, 'value': False}]}, 'good': 123})
        encoded = json.dumps(result)
        self.assertNotIn(code, encoded)
        self.assertNotIn('://', encoded)
        self.assertEqual(public_stats({code: ['x' * 2048] * 100, 'safe': 0},
                                     secrets=(code,), max_bytes=64, max_nodes=4), {'safe': 0})

    def test_size_depth_and_node_limits_bound_ever_growing_reports(self):
        result = public_stats({str(index): 'x' * 1000 for index in range(10000)}, max_bytes=4096)
        self.assertLessEqual(len(json.dumps(result).encode()), 4096)
        self.assertLessEqual(len(public_stats({str(index): index for index in range(10000)}, max_nodes=10)), 9)
        value = {'leaf': 1}
        for _ in range(MAX_DEPTH + 100):
            value = {'child': value}
        self.assertNotIn('leaf', json.dumps(public_stats(value)))

    def test_object_and_keyed_array_deltas_preserve_omitted_hardware(self):
        original = {'device': {'extruder': {'info': [{'id': 1, 'temp': 20, 'diameter': 0.4}, {'id': 0, 'temp': 210}]}}}
        changed = merge_report(original, {'device': {'extruder': {'info': [{'id': 0, 'temp': 211}]}}})
        self.assertEqual(changed['device']['extruder']['info'], [{'id': 1, 'temp': 20, 'diameter': 0.4}, {'id': 0, 'temp': 211}])
        self.assertEqual(original['device']['extruder']['info'][1]['temp'], 210)
        self.assertEqual(merge_report({'hms': [{'code': 1}]}, {'hms': []}), {'hms': []})
        self.assertEqual(merge_report({'x': [1, 2]}, {'x': [3]}), {'x': [3]})
