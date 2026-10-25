---
title: Backend providers
tags: [architecture, web, backend]
---

# Backend providers

Layerglass has two transport providers behind the same native video player.
The Python container is optional for the browser demo and local-file viewer;
it supplies the network protocols and retained recordings that browsers cannot.
This repository work does not replace or reconfigure an existing prototype
container, proxy, stored printer code or private deployment.

| Capability | Python backend | Browser demo / local file |
| --- | --- | --- |
| Approved printer discovery and identity | Yes | Unavailable |
| Per-printer access codes and saved connections | Server-owned | Unavailable |
| Bambu RTSPS, JPEG camera protocol and MQTT | Server adapters | Unavailable |
| Print telemetry | Actual printer data | Explicitly simulated in demo; absent for local files |
| Rewind video | Server DVR for this page's session | Generated clip or selected local file, limited to elapsed page time |
| Local still previews, diffusion, custom controls, native decoder | Yes | Yes |
| Server sprite fallback | Yes | Unavailable |
| Cast receiver network URL | Yes | Unavailable |
| Native video PiP | Browser-dependent | Browser-dependent; a finite clip remains a finite clip |

The generated five-minute demo video is a small bundled MP4 with a visible demo
watermark. It loads from the same static host, without a camera, Python process,
account, external media URL or cloud recording. Its simulated printer starts
after two seconds, pauses at 30 seconds, resumes at 35 seconds and finishes at
five minutes. Opening a local file replaces those simulated readings with no
telemetry. Neither source is admitted as a network printer.

## Selecting a provider

On a first visit to the hosted or standalone app, choose **Demo** or **Docker
backend**. Nothing connects, plays or probes a backend before that choice.
Docker asks for the container's HTTP(S) origin and checks `/api/backend` before
saving it. Failed or incompatible connections keep the chooser open.

Open **Settings → Connection** to change to **Docker backend** or **Demo** later.
The choice is saved as `layerglass-backend` and a
reload closes the previous page session. Browser mode also offers a local video
file picker; the file stays on the device and its object URL is released when
replaced. Its access does not persist across a reload.

Self-hosted HTML declares `<meta name="layerglass-backend" content="python">`.
The standalone static build changes that marker to `choose`; it supplies no
backend. Valid saved choices skip the chooser. Missing, corrupt or blocked
preferences show it again. A choice works for the current page even when storage
is blocked, but it cannot be remembered across reloads in that case.
`?backend=demo` is an explicit demo link for that navigation. There is
no backend detection by hostname, failed requests or a speculative LAN scan.
Python-served HTML already knows its backend and retains same-origin startup.

## Transport contract

[`apps/web/src/backend/`](../../apps/web/src/backend/) contains native ES modules. Each
provider exposes:

- `id`, `label`, and a frozen `capabilities` object.
- `resolve(path)`, which resolves service-relative paths against the selected
  Python origin and rejects credentials or another origin.
- `fetch(path, init)`, returning a standard `Response`. Python JSON media URLs
  are resolved centrally, while continuous binary responses pass through.
- `events(path)`, returning an EventSource-compatible subscription with
  `addEventListener`, `onerror`, `readyState` and `close`.

The existing update envelope is retained:
`{version: 1, catalog, status, session_id, replay, telemetry}`. Sessions retain
opaque IDs, clock anchors and page ownership. Browser media adds `kind: 'file'`,
`media_url`, and `preview_fallback: false`. Telemetry keeps epoch-second history
samples so statistics and timeline events follow the frame's recorded time.

The adapter is injected into `PageReplay`, `PlayerUpdates`, `PrinterHistory`,
`PlayerVideoStream`, scrub-preview fallback and Cast selection. Commands,
SSE, snapshots, session open/close, rewind media, JPEGs and history use the same
configured origin. Existing `printer-camera*` preview and preference namespaces
are retained. There is still one native video element and one decoder.

`GET /api/backend` identifies a compatible service with `id: 'python'`,
`protocol_version: 1` and capability flags. Saving a Python address first checks
this endpoint. No printer code is returned or written to browser configuration.

## Hosted app connecting to a local container

The default Python service permits the existing same-origin viewer. A separate
hosted frontend needs an explicit server opt-in:

```dotenv
VIEWER_ALLOWED_ORIGINS=https://app.layer.glass
```

The comma-separated list contains exact origins, without wildcard, credentials
or paths. CORS permission covers viewer APIs and session media only. Protected
POSTs still require `X-Viewer-Request: 1`; preflight admits only the small set of
viewer methods and headers. Arbitrary origins, credentialed CORS and an
`Authorization` preflight are not enabled. The existing read-only Cast-media
CORS policy remains unchanged.

If a web UI served by one Python service chooses a *different* backend, also
permit that destination in the **UI-serving** service's content security policy:

```dotenv
VIEWER_BACKEND_ORIGINS=https://printer.example.com
```

The service selected as the backend must independently allow the frontend's
origin. Neither environment variable exposes a LAN service or creates a tunnel.
No cloud proxy receives printer access codes or footage.

The hosted HTTPS app requires an HTTPS backend for portable behavior, including
iPhone Safari. An HTTP LAN address is supported when opening the local HTTP
viewer directly. Browsers can also require local-network permission; CORS cannot
override that policy. Chrome's newer
[Local Network Access permission](https://developer.chrome.com/blog/local-network-access)
does not provide equivalent support across every browser. A trusted certificate
and locally reachable HTTPS reverse proxy are the portable hosted-app path.

Requests keep `credentials: 'same-origin'` so a self-hosted installation's
cookie-authenticated reverse proxy continues working. Cross-origin backend
cookies and HTTP authentication are omitted. If a backend uses such a login,
open its own viewer origin; cross-origin authentication needs a separately
designed token/login flow. See the browser platform's
[CORS credential rules](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).

## Validation

`backend.test.js` checks selection, invalid/blocked storage, URL restrictions,
payload routing, browser history and subscription cleanup. `test_backend_cors.py`
uses real HTTP sockets to check exact-origin policy, protected POSTs and CSP.
`browser-backends.js` runs native playback, scrubbing, settings and local files
in Chromium and WebKit with every `/api/` and `/replay/` request blocked in demo
mode, then verifies the self-hosted Python default.

`browser-backend-origin.js` tests two distinct loopback origins with the fixture
configured to allow `http://localhost:8080` and to connect to
`http://127.0.0.1:8080`. It verifies real SSE, session creation, binary streaming
and a protected CORS POST. These are browser/fixture checks; physical iPhone
network permissions, trusted certificates, PiP and Cast require device checks.

[Vault home](../index.md) · [Architecture](overview.md)
