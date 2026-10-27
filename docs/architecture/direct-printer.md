---
title: Direct printer backend
tags: [architecture, printers, web]
---

# Direct printer backend

**Direct printer** connects this browser to an existing Klipper/Moonraker
printer controller and its configured MJPEG webcam. No LayerGlass Python
container, cloud relay or demo footage participates. This profile is live only.
Playback is verified in Chromium on desktop/mobile layouts. Safari and iPhone
browsers explicitly report this direct MJPEG profile as unavailable; use Docker
there. The existing Docker-backed native video player remains supported.

| Available | Requires another backend |
| --- | --- |
| Actual configured printer webcam, camera selection, fullscreen, diffusion and diagnostic connection metadata | Recording/VOD, rewind, timeline scrolling/events, printer telemetry, video PiP and casting |

The **Demo** provider remains separate: it simulates replay and printer readings
with bundled generated video. The **Docker backend** retains actual Bambu
connections, recorded history and telemetry.

## Supported printer profile

The browser approval registry is
[`DIRECT_PROFILES`](../../apps/local-backend/src/direct.ts), separate from the
Python service's camera-port approval list. Its initial approved firmware profile
is **Klipper / Moonraker**, with an enabled `mjpegstreamer` webcam configured in
Moonraker. This identifies the controller/firmware, rather than guessing a
printer manufacturer or hardware model.

Admission checks the official APIs:

1. `GET /server/info`: Moonraker version, API version, `klippy_apis` component
   and a connected Klipper host.
2. `GET /printer/info`: Klipper state, firmware version and hostname.
3. `GET /server/webcams/list`: enabled configured camera entries with stable
   UIDs and the approved `mjpegstreamer` service.

Only HTTP(S) camera addresses on the selected controller **origin**, including
its port, are accepted. URLs with credentials, credential query parameters,
fragments, other origins or unsupported streaming services are excluded. The
user enters a controller origin, never a generic stream URL. Identity probes
and the Chromium media fetch reject redirects. Chromium also validates that
the media is `multipart/x-mixed-replace` containing JPEG parts.

WebKit cancels multipart `fetch()` responses for non-image resources. Its native
MJPEG image loader also keeps requests alive after source changes and does not
reliably report ended connections. A tested native-image experiment could not
provide reliable ownership/reconnect behavior. The app therefore disables this
direct choice on Safari and iPhone browsers before opening any printer request.
An older saved direct preference shows an unsupported state and keeps settings
available so the user can choose Docker or Demo. There is no native-image
fallback, global `window.stop()` workaround or claim of direct iPhone support.

Use the printer controller's existing reverse-proxy origin when its camera and
Moonraker API run on different ports. That origin must expose the three API
paths above and the configured webcam path. For example, entering the bare
Moonraker `:7125` origin cannot admit a webcam hosted on `:8080`.

## Setup and browser requirements

Choose **Direct printer** at first launch, or open **Settings → Backend** and
choose **Direct printer (Klipper / Moonraker)**. Enter the reachable controller
origin. The app verifies it before saving the choice. **Settings → Printers**
then selects among its verified configured webcams. Camera setup/removal stays
with the controller; no scan, access-code or forget request is sent to it.

From `https://app.layer.glass`, the controller needs reachable **HTTPS with a
trusted certificate** and must allow the frontend's origin. In `moonraker.conf`,
add the exact frontend origin to its existing authorization configuration:

```ini
[authorization]
cors_domains:
    https://app.layer.glass
```

Preserve the installation's existing authorization policy. This first direct
profile supports an already authorized local client, such as an existing
Moonraker trusted-client configuration. It does not implement a login or store
or provide API keys. API probes and media fetches omit credentials.
If API authorization is needed, the connection view reports that requirement.

The webcam reverse proxy independently needs
`Access-Control-Allow-Origin: https://app.layer.glass` on its streaming response;
Moonraker's CORS setting does not add headers to another server. The streaming
response must remain unbuffered. Browsers may also request local-network access.
For an HTTP-only LAN controller, use an HTTP-served LayerGlass frontend on the
LAN; an HTTPS page cannot portably override mixed-content restrictions.

A Python-served UI's CSP must also permit a separately selected direct origin
via `VIEWER_BACKEND_ORIGINS`, as with an external Python backend. Public static
hosting already permits HTTPS connections and blob images. No Cloudflare route
proxies the camera or receives its footage.

## Why current Bambu printers need Docker

The currently approved Bambu cameras use RTSPS or a proprietary TLS/JPEG socket,
and telemetry uses native MQTT/TLS. Ordinary web pages cannot open raw TCP/UDP
sockets or play RTSPS directly. WebAssembly/JavaScript decoding does not remove
that transport restriction. Chrome's Direct Sockets API belongs to installed
Isolated Web Apps, not an ordinary website/PWA, and does not provide an iPhone
Safari solution. Direct mode does not claim to make an existing Bambu printer
browser compatible; use its Docker backend.

The [browser-direct RTSPS experiment](../reference/browser-rtsp.md) records an
actual saved-code camera connection, the camera endpoint's rejected WebSocket
upgrade, Chromium/WebKit protocol checks and the JavaScript/WASM libraries
reviewed. It also found a printer HTTPS tunnel whose streaming response lacks
CORS authorization. Those libraries still need an accessible camera transport
or a bridge.

## Runtime and cleanup

After identity is checked on selection and once for the page, in-memory
state/heartbeats keep the
existing player subscription contract without network polling. One HTTP webcam
response supplies multipart frames.
**Refresh viewer** starts a new identity check. If an earlier check finishes
later, it cannot restore an old webcam configuration or replace the current
connection error.
[`direct-stream.js`](../../apps/local-backend/src/stream.ts) only separates JPEG
bytes; the existing native image element decodes them. It bounds frames to
2 MiB, headers to 8 KiB, and pending rendering to the newest frame. Object URLs
are revoked on replacement and disconnect. No images enter
preview RAM history, IndexedDB, a session API or a DVR.

Switching cameras, hiding the page or going offline aborts the stream. An
interrupted visible stream reconnects with bounded exponential backoff. The
transport also detects missing decoded frames.
An invalid media response reports a connection failure; no finite clip or
simulated printer replaces it. The existing native video element is kept idle,
so MJPEG does not advertise video PiP, casting or pause/rewind controls.

## Verification and sources

`direct.test.ts` covers approval, invalid devices, URLs, authorization failures,
request sharing, unavailable capabilities, multipart chunk boundaries and
bounded image cleanup. `browser-direct.ts` serves generated JPEGs over a real
cross-origin HTTP multipart response and checks Chromium camera playback,
selection, reconnect, CORS, rejected redirects and live-only controls. WebKit
checks the explicit unsupported state, zero printer requests, and recovery from
an old direct preference to the working Demo provider. These are
fixtures; Chromium is explicitly granted loopback permission for its synthetic
frontend, while production retains the browser's permission prompt. A physical
printer and device network/certificate policy still need device testing.

Primary protocol/platform references:

- [Moonraker server identity](https://moonraker.readthedocs.io/en/latest/external_api/server/)
- [Klipper host identity through Moonraker](https://moonraker.readthedocs.io/en/latest/external_api/printer/)
- [Moonraker configured webcam schema](https://moonraker.readthedocs.io/en/latest/external_api/webcams/)
- [Moonraker authorization/CORS configuration](https://moonraker.readthedocs.io/en/latest/configuration/#authorization)
- [Chrome Direct Sockets and ordinary browser protocol limits](https://developer.chrome.com/docs/iwa/direct-sockets)
- [WebKit multipart image-resource restriction](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/loader/SubresourceLoader.cpp)
- [WebKit image cancellation issue](https://bugs.webkit.org/show_bug.cgi?id=6656)
- [WebKit MJPEG connection ownership issue](https://bugs.webkit.org/show_bug.cgi?id=23402)
- [Browser mixed-content restrictions](https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content)
- [Camera-streamer's documented MJPEG transport](https://github.com/ayufan/camera-streamer/blob/main/docs/streaming.md)

[Backend providers](backend-providers.md) · [Approved adapters](../camera-adapters.md) · [Vault home](../index.md)
