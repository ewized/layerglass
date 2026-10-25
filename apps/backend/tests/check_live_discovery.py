"""Verify completed discovery, one requested scan, and the shared API cooldown."""

import json
import time
from urllib.request import Request, urlopen


BASE = 'http://127.0.0.1:8080'


def get_catalog():
    with urlopen(BASE + '/api/cameras', timeout=5) as response:
        return json.load(response)


def request_scan():
    request = Request(BASE + '/api/discover', data=b'{}',
                      headers={'X-Viewer-Request': '1', 'Content-Type': 'application/json'})
    with urlopen(request, timeout=5) as response:
        assert response.status == 202
        return json.load(response)


def completed():
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        catalog = get_catalog()
        if catalog['discovery']['state'] == 'done':
            return catalog
        if catalog['discovery']['state'] == 'error':
            raise RuntimeError('The running server scan failed.')
        time.sleep(0.05)
    raise RuntimeError('The running server scan did not finish.')


def metrics(catalog):
    scan = catalog['discovery']
    return {key: scan[key] for key in ('duration_seconds', 'checked', 'total', 'cached', 'probed', 'names_cached')}


previous = completed()
assert previous['discovery']['checked'] == previous['discovery']['total']
assert any(camera.get('configured') for camera in previous['cameras'])
for _attempt in range(10):
    result = request_scan()
    if result['queued']:
        break
    time.sleep(max(0.1, min(result['retry_after_seconds'], 10)))
else:
    raise RuntimeError('The requested scan was not accepted.')
repeat = completed()
assert repeat['discovery']['scan_id'] != previous['discovery']['scan_id']
assert repeat['discovery']['checked'] == repeat['discovery']['total']
assert any(camera.get('discovered') for camera in repeat['cameras'])
throttled = request_scan()
assert not throttled['queued']
assert throttled['retry_after_seconds'] > 0
assert throttled['discovery']['scan_id'] == repeat['discovery']['scan_id']
print(json.dumps({'previous_scan': metrics(previous), 'requested_scan': metrics(repeat),
                  'shared_cooldown': {'queued': throttled['queued'],
                                      'retry_after_seconds': throttled['retry_after_seconds']},
                  'discovered_printers': sum(bool(camera.get('discovered')) for camera in repeat['cameras'])}))
