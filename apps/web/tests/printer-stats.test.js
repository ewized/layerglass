import assert from 'node:assert/strict';
import test from 'node:test';
import { prettyStatKey, printerStatValue, printerStatRows } from '../src/printer-stats.js';

test('printer keys become readable labels without a per-stat label list', () => {
  for (const [key, label] of Object.entries({ nozzle_2_target: 'Nozzle 2 Target', mc_percent: 'MC Percent',
    gcode_state: 'G-code State', wifi_signal: 'Wi-Fi Signal', AMSStatus: 'AMS Status',
    trayRFID: 'Tray RFID', fanSpeed: 'Fan Speed', camera_ip: 'Camera IP', 'new-sensor_value': 'New Sensor Value' })) {
    assert.equal(prettyStatKey(key), label);
  }
});

test('the quick panel keeps print diagnostics and leaves native detail for debug export', () => {
  const rows = printerStatRows({ name: 'Workshop', serial: '20P001', host: '192.168.4.104' }, {
    progress: 0, nozzle_2: 25, active_nozzle: 2, future_metric: false,
    reported: { print: { ams: { humidity: 4, tray: [{ id: 0, tray_type: 'PLA', remaining: 0 }] },
      newSensor: { ready: false }, hms: [], unknown: null } },
  });
  const byKey = Object.fromEntries(rows.map(([label, value, key]) => [key, { label, value }]));
  assert.equal(byKey.future_metric, undefined);
  assert.equal(byKey.progress.value, '0%');
  assert(!Object.keys(byKey).some(key => key.startsWith('reported')));
  assert.equal(byKey.nozzle_2.value, '25 °C (77 °F)');
  assert.equal(byKey.active_nozzle.value, '2');
  assert.equal(byKey.camera_ip.label, 'Camera IP');
});

test('readings keep Celsius/Fahrenheit, duration and percentage formatting', () => {
  assert.equal(printerStatValue(['nozzle_2'], 25), '25 °C (77 °F)');
  assert.equal(printerStatValue(['bed_target'], 0), '0 °C (32 °F)');
  assert.equal(printerStatValue(['print', 'nozzle_temper'], 210), '210 °C (410 °F)');
  assert.equal(printerStatValue(['print', 'ams', 'tray', 'nozzle_temp_max'], '240'), '240 °C (464 °F)');
  assert.equal(printerStatValue(['print', 'drying_temp'], '0'), '0 °C (32 °F)');
  assert.equal(printerStatValue(['print', 'tray_uuid'], '00000123'), '00000123');
  assert.equal(printerStatValue(['print', 'device', 'extruder', 'info', '0', 'temp'], 14090450), '14090450');
  assert.equal(printerStatValue(['print', 'device', 'extruder', 'info', '0', 'temp'], '14090450'), '14090450');
  assert.equal(printerStatValue(['elapsed_seconds'], 3661), '1h 1m 1s');
  assert.equal(printerStatValue(['remaining_minutes'], 90), '1h 30m 0s');
  assert.equal(printerStatValue(['aux_fan'], 0), '0%');
  assert.equal(printerStatValue(['updated_at'], 1700000000), '2023-11-14T22:13:20.000Z');
  assert.equal(printerStatValue(['anything'], NaN), '—');
  assert.equal(printerStatValue(['sensor_coefficient'], 0.00000321), '0.00000321');
});

test('paired temperatures, layers, speed and fans stay compact without losing zero values', () => {
  const rows = new Map(printerStatRows(null, { layer: 0, total_layers: 50, nozzle_1: 210, nozzle_1_target: 215,
    nozzle_count: 2, nozzle_2: 30, nozzle_2_target: 0, bed: 60, bed_target: 60,
    speed_percent: 100, speed_mode: 'Standard', aux_fan: 0, part_fan: 100, error: 0 }).map(([, value, key]) => [key, value]));
  assert.equal(rows.get('layer'), '0 / 50');
  assert.equal(rows.get('nozzle_1'), '210 / 215 °C (410 / 419 °F)');
  assert.equal(rows.get('nozzle_2'), '30 / 0 °C (86 / 32 °F)');
  assert.equal(rows.get('bed'), '60 / 60 °C (140 / 140 °F)');
  assert.equal(rows.get('speed'), '100% · Standard');
  assert.equal(rows.get('fans'), 'Part 100% · Aux 0%');
  assert.equal(rows.get('error'), '0');
  assert(!rows.has('nozzle_1_target') && !rows.has('aux_fan') && !rows.has('total_layers'));
});

test('changing printers removes absent stats, without inventing nozzle values', () => {
  const dual = printerStatRows(null, { nozzle_count: 2, nozzle: 999, nozzle_2: 30 });
  assert.equal(dual.find(([, , key]) => key === 'nozzle_1')[1], '—');
  assert(dual.some(([, , key]) => key === 'nozzle_2'));
  const single = printerStatRows(null, { nozzle: 210 });
  assert(!single.some(([, , key]) => key === 'nozzle_2'));
});

test('hundreds of native readings do not inflate the quick panel, but active alerts appear', () => {
  const reported = { print: { ...Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`sensor_${i}`, i])),
    hms: [{ code: '123', attr: '456' }] } };
  const rows = printerStatRows(null, { progress: 40, print_state: 'RUNNING', alerts: ['123 / 456'], reported });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find(([, , key]) => key === 'alerts'), ['Alerts', '123 / 456', 'alerts']);
});
