import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalFileBackend } from '../src/file.js';

test('local files expose only page-retained video and no simulated printer data', async () => {
  let now = 1000;
  const backend = new LocalFileBackend({ clock: () => now });
  backend.setLocalMedia(new Blob(['local video']));
  try {
    const camera = backend.catalog().default_camera_id;
    const session = await (await backend.fetch('/api/sessions', {
      method: 'POST', body: JSON.stringify({ camera_id: camera }),
    })).json();
    assert.equal(session.end_seconds, 0);
    assert.equal(session.telemetry, false);
    assert.equal(session.demo, false);
    now += 45;
    backend.setDuration(30);
    assert.equal(backend.session(session.session_id).end_seconds, 30);
    assert.equal(backend.history(session.session_id), null);
    assert.equal(backend.printer().state, 'unsupported');
    assert.equal(backend.capabilities.discovery, false);
    assert.equal((await backend.fetch('/api/discover', { method: 'POST' })).status, 501);
    assert.equal(await backend.prepareMedia(), backend.localURL);
    await backend.fetch(`/api/sessions/${session.session_id}/close`, { method: 'POST' });
    assert.equal(backend.session(session.session_id), null);
  } finally { URL.revokeObjectURL(backend.localURL); }
});

test('replacing a local file releases its URL and starts a fresh page clock', async () => {
  let now = 1000;
  const backend = new LocalFileBackend({ clock: () => now });
  backend.setLocalMedia(new Blob(['first']));
  const first = backend.localURL;
  now += 50;
  backend.setLocalMedia(new Blob(['second']));
  try {
    assert.notEqual(backend.localURL, first);
    await assert.rejects(fetch(first));
    assert.equal(backend.elapsed(), 0);
    assert.equal(backend.duration, Infinity);
    assert.equal(backend.generation, 2);
    assert.equal(await (await fetch(backend.localURL)).text(), 'second');
  } finally { URL.revokeObjectURL(backend.localURL); }
});

test('local-file subscriptions close without emitting further updates', context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const backend = new LocalFileBackend();
  const source = backend.events('/api/events');
  let updates = 0;
  source.addEventListener('state', () => updates++);
  context.mock.timers.tick(1);
  assert.equal(updates, 1);
  source.close();
  context.mock.timers.tick(5000);
  assert.equal(updates, 1);
});
