"""Manufacturer-independent public printer identity."""

import re

SERIAL = re.compile(r'[A-Za-z0-9]{6,64}')


def text(value, limit=128):
    if not isinstance(value, str):
        return None
    value = ''.join(character for character in value if character.isprintable()).strip()
    return value[:limit] or None


def identity(values):
    result = {key: value for key in ('name', 'model', 'serial', 'firmware')
              if (value := text(values.get(key)))}
    if 'serial' in result and not SERIAL.fullmatch(result['serial']):
        del result['serial']
    return result


def display_name(values, host, camera_id):
    values = identity(values)
    name = values.get('name')
    if name and name != host:
        return name
    return values.get('serial') or f'Camera {camera_id[:8]}'
