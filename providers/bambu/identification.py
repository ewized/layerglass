"""Read-only Bambu identification before a LAN access code is available."""

from functools import partial
from pathlib import Path
import socket
import ssl
import time
import uuid

import paho.mqtt.client as mqtt

from identity import SERIAL
from ..policy import APPROVED
from ..identification import IdentityCheck
from .telemetry import model_code


def tls_context():
    context = ssl.create_default_context(cafile=str(Path(__file__).with_name('ca.pem')))
    context.check_hostname = False  # The certificate names the serial, not the IP.
    context.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return context


def verified_identity(connection, method):
    # Only call after a CERT_REQUIRED handshake against the manufacturer's CA.
    serial = next((value for group in connection.getpeercert().get('subject', ())
                   for key, value in group if key == 'commonName'), '')
    model = model_code(serial=serial)
    if not SERIAL.fullmatch(serial) or not any(model in profile['models'] for profile in APPROVED.get('bambu', {}).values()):
        return None
    return {'provider': 'bambu', 'serial': serial, 'model': model, 'identification': method}


def camera_identity(host, port, stop_event):
    if stop_event.is_set():
        return None
    with socket.create_connection((host, port), timeout=0.45) as raw:
        raw.settimeout(1.5)
        with tls_context().wrap_socket(raw, server_hostname=host) as connection:
            return verified_identity(connection, 'camera-tls')


def mqtt_identity(host, stop_event, client_factory=None):
    if stop_event.is_set():
        return None
    client = (client_factory or mqtt.Client)(mqtt.CallbackAPIVersion.VERSION2,
        client_id=f'printer-scan-{uuid.uuid4().hex[:12]}', reconnect_on_failure=False)
    values = {}
    acknowledged = False

    def opened(_client, _userdata, connection):
        metadata = verified_identity(connection, 'mqtt')
        if not metadata:
            raise ssl.SSLError('Not an approved printer identity.')
        values.update(metadata)

    def connected(_client, _userdata, _flags, _reason, _properties):
        # A CONNACK, including authentication refusal, confirms MQTT. No
        # credentials, subscriptions, status requests, or commands are sent.
        nonlocal acknowledged
        acknowledged = True

    client.tls_set_context(tls_context())
    client.tls_insecure_set(True)
    client.connect_timeout = 0.7
    client.on_socket_open = opened
    client.on_connect = connected
    try:
        client.connect(host, 8883, keepalive=5)
        deadline = time.monotonic() + 0.6
        while not acknowledged and not stop_event.is_set() and time.monotonic() < deadline:
            result = client.loop(timeout=min(0.1, max(0, deadline - time.monotonic())))
            if result != mqtt.MQTT_ERR_SUCCESS:
                break
        return values if acknowledged and values else None
    finally:
        client.disconnect()
        connection = client.socket()
        if connection:
            connection.close()


def identifiers(host, port, stop_event):
    return (IdentityCheck('mqtt', partial(mqtt_identity, host, stop_event)),
            IdentityCheck('camera-tls', partial(camera_identity, host, port, stop_event), per_port=True))
