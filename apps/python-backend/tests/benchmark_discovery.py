"""Two explicit, credential-free scans using the running server's LAN scope."""

import json
from pathlib import Path
import sys
import time
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from discovery import Discovery


with urlopen('http://127.0.0.1:8080/api/cameras', timeout=5) as response:
    catalog = json.load(response)
scanner = Discovery('', ','.join(catalog['discovery']['networks']))
scanner.prioritize(camera['host'] for camera in catalog['cameras'])
try:
    for label in ('cold', 'warm'):
        if scanner.started is not None:
            scanner.stop_event.wait(max(0, scanner._next_scan() - time.monotonic()) + 0.02)
        began = time.monotonic()
        if not scanner.start():
            raise RuntimeError('The benchmark scan could not start.')
        first = None
        while scanner.thread.is_alive() and time.monotonic() - began < 90:
            if first is None and scanner.status()['found']:
                first = round(time.monotonic() - began, 3)
            scanner.thread.join(0.02)
        data = scanner.status()
        print(json.dumps({'run': label, 'seconds': round(time.monotonic() - began, 3),
                          'first_result_seconds': first, 'state': data['state'],
                          'checked': data['checked'], 'total': data['total'],
                          'cached': data['cached'], 'probed': data['probed'],
                          'found': len(data['found']), 'names_cached': data['names_cached']}), flush=True)
        if data['state'] != 'done':
            raise RuntimeError('The benchmark did not complete successfully.')
finally:
    scanner.close()
