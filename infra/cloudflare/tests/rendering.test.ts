import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.ts';
import { renderAppShell } from '../src/render-shell.ts';
import type { Environment } from '../src/worker.ts';

const source =
  '<head></head><printer-backend-picker id="backend-picker" hidden></printer-backend-picker>' +
  '<printer-player id="player"><div class="loader"></div></printer-player>';
function assets() {
  const requests: Request[] = [];
  const environment: Environment = {
    ASSETS: {
      async fetch(request) {
        requests.push(request);
        return new Response(new URL(request.url).pathname === '/' ? source : 'missing', {
          status: new URL(request.url).pathname === '/' ? 200 : 404,
          headers: {
            'Content-Type': 'text/html',
            'Content-Security-Policy': "style-src 'self'; frame-ancestors 'none'",
            ETag: 'asset-etag',
          },
        });
      },
    },
  };
  return { environment, requests };
}

test('public shell SSR and Lit adoption share one backend-choice template', () => {
  const html = renderAppShell(source, 'static');
  assert.match(html, /Choose your backend/);
  assert.match(html, /id="backend-picker" data-ssr>/);
  assert.match(html, /<printer-player id="player" hidden>/);
  assert.equal(renderAppShell(html, 'static'), html);
  assert.equal(renderAppShell(html, 'edge'), renderAppShell(source, 'edge'));
});

test('the edge renders a public chooser without forwarding visitor data to a backend', async () => {
  const fixture = assets();
  const response = await worker.fetch(
    new Request('https://app.layer.glass/?printer=http://192.0.2.10&code=private'),
    fixture.environment,
  );
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-LayerGlass-Renderer'), 'edge');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('ETag'), null);
  assert.equal(response.headers.get('Content-Security-Policy'), "style-src 'self'; frame-ancestors 'none'");
  assert.match(html, /content="edge"/);
  assert.match(html, /Choose your backend/);
  assert.doesNotMatch(html, /192\.0\.2|private|unsafe-inline/);
  assert.deepEqual(
    fixture.requests.map((request) => request.url),
    ['https://app.layer.glass/'],
  );
});

test('demo navigation renders the loading surface and keeps explicit provider selection in the browser', async () => {
  const { environment } = assets();
  const html = await (
    await worker.fetch(new Request('https://app.layer.glass/?backend=demo'), environment)
  ).text();
  assert.match(html, /id="backend-picker" data-ssr hidden>/);
  assert.match(html, /<printer-player id="player">/);
});

test('HEAD has the same shell headers without a body; mutations cannot render a page', async () => {
  const fixture = assets();
  const head = await worker.fetch(
    new Request('https://app.layer.glass/', { method: 'HEAD' }),
    fixture.environment,
  );
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('X-LayerGlass-Renderer'), 'edge');
  assert.equal(await head.text(), '');
  const post = await worker.fetch(
    new Request('https://app.layer.glass/', { method: 'POST' }),
    fixture.environment,
  );
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD');
  assert.equal(fixture.requests.length, 1);
});

test('edge implementation files remain private and API misses retain real 404 status', async () => {
  const fixture = assets();
  for (const path of ['/.edge/layerglass.mjs', '/_headers', '/.assetsignore', '/api/backend']) {
    assert.equal(
      (await worker.fetch(new Request(`https://app.layer.glass${path}`), fixture.environment)).status,
      404,
    );
  }
  assert.deepEqual(
    fixture.requests.map((request) => new URL(request.url).pathname),
    ['/api/backend'],
  );
});
