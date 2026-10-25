"""Shared, read-only Bambu printer telemetry over local MQTT/TLS."""

import json
import math
from pathlib import Path
import re
import ssl
import subprocess
import threading
import time
from urllib.parse import unquote, urlsplit

import paho.mqtt.client as mqtt


from identity import SERIAL, display_name, identity, text
from ..policy import APPROVED
from ..telemetry import public_stats, merge_report

MODELS = json.loads(Path(__file__).with_name('models.json').read_text())


def number(value, minimum, maximum, integer=False):
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
        if math.isfinite(value) and minimum <= value <= maximum and (not integer or value.is_integer()):
            return int(value) if integer else value
    except (ValueError, TypeError, OverflowError):
        pass
    return None


def temperatures(values, field, raw, maximum=1000):
    packed = number(raw, 0, 2 ** 32 - 1, integer=True)
    if packed is not None:
        current, target = packed & 0xffff, packed >> 16
        values[field] = current if current <= maximum else None
        values[field + '_target'] = target if target <= maximum else None


def model_code(model=None, serial=None):
    if model in MODELS:
        return model
    for code, item in MODELS.items():
        if serial and item['prefix'] and serial.startswith(item['prefix']):
            return code
    legacy = {'3DPrinter-X1-Carbon': 'BL-P001', '3DPrinter-X1': 'BL-P002',
              '3DPrinter-P1P': 'C11', '3DPrinter-P1S': 'C12'}
    return legacy.get(model)


def model_name(model=None, serial=None):
    code = model_code(model, serial)
    return MODELS[code]['name'] if code else None


def camera_protocol(values):
    code = model_code(values.get('model'), values.get('serial'))
    for kind, profile in APPROVED.get('bambu', {}).items():
        if code in profile['models']:
            return kind
    return None


def certificate_identity(connection):
    """Read a candidate's public serial before pairing; MQTT verifies trust later."""
    try:
        result = subprocess.run(['openssl', 'x509', '-inform', 'DER', '-noout', '-subject', '-nameopt', 'RFC2253'],
                                input=connection.getpeercert(binary_form=True), capture_output=True, timeout=2)
        match = re.search(r'(?:subject=|,)CN=([A-Za-z0-9]{6,64})(?:,|$)', result.stdout.decode().strip())
        if match and model_name(serial=match[1]):
            return {'serial': match[1]}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return {}


class PrinterTelemetry:
    def __init__(self, source, saved=None, on_identity=None, client_factory=None):
        self.host = urlsplit(source).hostname
        self.code = unquote(urlsplit(source).password or '')
        self.identity = identity(saved or {})
        self.on_identity = on_identity
        self.lock = threading.Lock()
        self.client = None
        self.factory = client_factory or mqtt.Client
        self.connection = 'connecting'
        self.values = {}
        self.reported = {}
        self.last_report = None
        self.last_snapshot = None
        self.print_started = None
        self.print_finished = None
        self.elapsed_source = None
        self.print_keys = {}
        self.closed = False

    def start(self):
        if not self.code:
            self.connection = 'access_code_required'
            return
        context = ssl.create_default_context(cafile=str(Path(__file__).with_name('ca.pem')))
        # Bambu certificates identify the printer's serial, rather than its IP.
        # Verify its CA here and its serial in on_socket_open, before CONNECT
        # sends credentials. Older BBL roots lack the strict key-usage extension.
        context.check_hostname = False
        context.verify_flags &= ~ssl.VERIFY_X509_STRICT
        client = self.factory(mqtt.CallbackAPIVersion.VERSION2)
        client.username_pw_set('bblp', self.code)
        client.tls_set_context(context)
        client.tls_insecure_set(True)  # Hostname only; CERT_REQUIRED remains enabled.
        client.on_socket_open = self._socket_open
        client.on_connect = self._connected
        client.on_connect_fail = self._connect_failed
        client.on_disconnect = self._disconnected
        client.on_subscribe = self._subscribed
        client.on_message = self._message
        client.reconnect_delay_set(min_delay=2, max_delay=60)
        client.connect_timeout = 5
        self.client = client
        client.connect_async(self.host, 8883, keepalive=30)
        client.loop_start()

    def close(self):
        with self.lock:
            self.closed = True
            self.connection = 'stopped'
        if self.client:
            self.client.disconnect()
            self.client.loop_stop()

    def _identity(self, update):
        with self.lock:
            if self.closed:
                return
            updated = dict(self.identity, **identity(update))
            if updated == self.identity:
                return
            self.identity = updated
        if self.on_identity:
            self.on_identity(identity(update))

    def _socket_open(self, client, userdata, connection):
        certificate = connection.getpeercert()
        serial = next((value for group in certificate.get('subject', ())
                       for key, value in group if key == 'commonName'), '')
        expected = self.identity.get('serial')
        if not SERIAL.fullmatch(serial) or (expected and expected != serial):
            with self.lock:
                self.connection = 'certificate_error'
            raise ssl.SSLError('Printer certificate identity changed.')
        self._identity({'serial': serial})

    def _connected(self, client, userdata, flags, reason, properties):
        with self.lock:
            if self.closed:
                return
            self.connection = 'connected' if reason == 0 else 'access_code_rejected'
            serial = self.identity.get('serial')
        if reason == 0 and serial:
            client.subscribe(f'device/{serial}/report', qos=0)

    def _disconnected(self, client, userdata, flags, reason, properties):
        with self.lock:
            if not self.closed and self.connection not in ('access_code_rejected', 'certificate_error'):
                self.connection = 'reconnecting'

    def _connect_failed(self, client, userdata):
        with self.lock:
            if not self.closed and self.connection != 'certificate_error':
                self.connection = 'unavailable'

    def _subscribed(self, client, userdata, mid, reasons, properties):
        if self.closed:
            return
        if any(reason.is_failure for reason in reasons):
            with self.lock:
                self.connection = 'unavailable'
            return
        now = time.monotonic()
        # One initial read, then pushed deltas. Frequent pushall requests can
        # overload P1 printers, including during repeated reconnects.
        if self.last_snapshot is not None and now - self.last_snapshot < 300:
            return
        self.last_snapshot = now
        serial = self.identity.get('serial')
        for section, command in (('info', 'get_version'), ('pushing', 'pushall')):
            request = {'sequence_id': '0', 'command': command}
            if command == 'pushall':
                request.update(version=1, push_target=1)
            client.publish(f'device/{serial}/request', json.dumps({section: request}), qos=0, retain=False)

    def _message(self, client, userdata, message):
        serial = self.identity.get('serial')
        if self.closed or message.topic != f'device/{serial}/report' or len(message.payload) > 512 * 1024:
            return
        try:
            data = json.loads(message.payload)
        except (ValueError, UnicodeError, RecursionError):
            return
        if not isinstance(data, dict):
            return
        printing = data.get('print')
        if isinstance(printing, dict):
            self._print(printing)
        info = data.get('info')
        if isinstance(info, dict):
            modules = info.get('module', [])
            if isinstance(modules, list):
                for module in modules:
                    if isinstance(module, dict) and module.get('name') == 'ota':
                        self._identity({'firmware': module.get('sw_ver')})
            self._identity({'name': info.get('dev_name') or info.get('device_name')})
        other = public_stats({key: value for key, value in data.items() if key != 'print'}, secrets=(self.code,))
        if other:
            with self.lock:
                if not self.closed:
                    self.reported = public_stats(merge_report(self.reported, other), secrets=(self.code,))

    def _print(self, data):
        values = {}
        reported = public_stats(data, secrets=(self.code,))
        numbers = {'mc_percent': ('progress', 0, 100), 'mc_remaining_time': ('remaining_minutes', 0, 1000000),
                   'layer_num': ('layer', 0, 1000000), 'total_layer_num': ('total_layers', 0, 1000000),
                   'nozzle_temper': ('nozzle', -50, 1000), 'nozzle_target_temper': ('nozzle_target', 0, 1000),
                   'bed_temper': ('bed', -50, 500), 'bed_target_temper': ('bed_target', 0, 500),
                   'chamber_temper': ('chamber', -50, 500), 'ctt': ('chamber_target', 0, 500),
                   'spd_mag': ('speed_percent', 0, 1000),
                   'print_error': ('error', 0, 2 ** 64)}
        for source, (target, minimum, maximum) in numbers.items():
            value = number(data.get(source), minimum, maximum)
            if value is not None:
                values[target] = value
        mode = number(data.get('spd_lvl'), 1, 4, integer=True)
        if mode is not None:
            values['speed_mode'] = {1: 'Silent', 2: 'Standard', 3: 'Sport', 4: 'Ludicrous'}[mode]
        # Legacy fan reports use 0..15; fan_gear carries full 0..255 values.
        gear = number(data.get('fan_gear'), 0, 2 ** 32 - 1, integer=True)
        for index, (source, field) in enumerate((('cooling_fan_speed', 'part_fan'),
                                               ('big_fan1_speed', 'aux_fan'), ('big_fan2_speed', 'exhaust_fan'))):
            speed = ((gear >> (index * 8)) & 255) / 255 * 100 if gear is not None else None
            legacy = number(data.get(source), 0, 15)
            if speed is None and legacy is not None:
                speed = legacy / 15 * 100
            if speed is not None:
                values[field] = round(speed, 1)
        heatbreak = number(data.get('heatbreak_fan_speed'), 0, 15)
        if heatbreak is not None:
            values['heatbreak_fan'] = round(heatbreak / 15 * 100, 1)
        for source, target in (('gcode_state', 'print_state'), ('wifi_signal', 'wifi')):
            if value := text(data.get(source), 48):
                values[target] = value
        if job := text(data.get('subtask_name') or data.get('gcode_file')):
            values['job'] = job.replace('\\', '/').rsplit('/', 1)[-1]
        elif 'subtask_name' in data or 'gcode_file' in data:
            values['job'] = None
        device = data.get('device')
        device = device if isinstance(device, dict) else {}
        extruder = device.get('extruder')
        extruder = extruder if isinstance(extruder, dict) else {}
        state = number(extruder.get('state'), 0, 2 ** 32 - 1, integer=True)
        if state is not None:
            count, active = state & 15, (state >> 4) & 15
            if 1 <= count <= 2:
                values['nozzle_count'] = count
                values['active_nozzle'] = active + 1 if active < count else None
        info = extruder.get('info')
        inferred_count = 0
        if isinstance(info, list):
            for item in info[:16]:
                if not isinstance(item, dict):
                    continue
                index = number(item.get('id'), 0, 1, integer=True)
                if index is None:
                    continue
                inferred_count = max(inferred_count, index + 1)
                temperatures(values, f'nozzle_{index + 1}', item.get('temp'))
        for block, field in (('ctc', 'chamber'), ('bed', 'bed')):
            part = device.get(block)
            info = part.get('info') if isinstance(part, dict) else None
            if isinstance(info, dict):
                temperatures(values, field, info.get('temp'), maximum=500)
        self._identity({'name': data.get('dev_name') or data.get('device_name') or device.get('name'),
                        'model': data.get('model_id')})
        with self.lock:
            if not self.closed:
                if inferred_count and 'nozzle_count' not in values:
                    values['nozzle_count'] = max(inferred_count, self.values.get('nozzle_count', 1))
                self._print_clock(data, values, time.time())
                self.values.update(values)
                self.reported = public_stats(merge_report(self.reported, {'print': reported}), secrets=(self.code,))
                self.last_report = time.time()

    def _print_clock(self, data, values, now):
        previous = self.values.get('print_state')
        state = values.get('print_state', previous)
        active = {'PREPARE', 'RUNNING', 'PAUSE'}
        terminal = {'IDLE', 'FINISH', 'FAILED'}
        keys = {name: value for name in ('subtask_id', 'task_id')
                if (value := text(data.get(name), 128)) and value != '0'}
        changed = any(name in self.print_keys and value != self.print_keys[name] for name, value in keys.items())
        if changed or previous in terminal and state in active:
            self.print_started = self.print_finished = self.elapsed_source = None
            self.print_keys = keys
        else:
            self.print_keys.update(keys)
        # Joining a running job is not evidence of its start. Never substitute
        # browser/server uptime or infer elapsed time from a changing estimate.
        if previous in terminal and state in active:
            self.print_started, self.elapsed_source = now, 'observed'
        started = number(data.get('gcode_start_time'), 946684800, now)
        if started is not None and state in active:
            self.print_started, self.elapsed_source = started, 'printer'
            self.print_finished = None
        if previous in active and state in terminal and self.print_started is not None:
            self.print_finished = now

    def status(self):
        with self.lock:
            now = time.time()
            connection = self.connection
            if connection == 'connected':
                connection = 'waiting' if self.last_report is None else 'stale' if now - self.last_report > 60 else 'connected'
            elapsed = None
            if self.print_started is not None:
                if self.print_finished is not None:
                    elapsed = self.print_finished - self.print_started
                elif connection == 'connected' and self.values.get('print_state') in ('PREPARE', 'RUNNING', 'PAUSE'):
                    elapsed = now - self.print_started
            return public_stats({'connection': connection, 'updated_at': round(self.last_report) if self.last_report else None,
                    'model': model_name(self.identity.get('model'), self.identity.get('serial')),
                    'firmware': self.identity.get('firmware'), **self.values,
                    'elapsed_seconds': max(0, math.floor(elapsed)) if elapsed is not None else None,
                    'elapsed_source': self.elapsed_source if elapsed is not None else None,
                    **({'reported': self.reported} if self.reported else {})}, secrets=(self.code,))
