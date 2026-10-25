---
title: Architecture
tags: [architecture]
---

# Architecture

[Vault home](../index.md)

Layerglass keeps its established Python modules and native ES modules inside
an [Nx workspace](workspace.md). The Python backend, browser application and
product website have independent targets. The backend can still serve the
browser application together in one Docker container.
An explicit [backend provider](backend-providers.md) selects that service or an
entirely browser-run demo/local video. Standalone hosting first asks for a backend;
the Python-served viewer defaults to its own backend.

| Part | Source | Responsibility |
| --- | --- | --- |
| HTTP application | [`app.py`](../../apps/backend/app.py) | Configuration, routes, relay lifecycle, SSE and static shell |
| Printer registry | [`cameras.py`](../../apps/backend/cameras.py), [`identity.py`](../../apps/backend/identity.py) | Known printers, per-printer credentials, identity and relay ownership |
| Discovery | [`discovery.py`](../../apps/backend/discovery.py) | Bounded camera-port scans, identity races, caching and backoff |
| Manufacturer adapters | [`apps/backend/providers/`](../../apps/backend/providers/) | Approved profiles, transport setup, identity and read-only telemetry |
| Session DVR | [`replay.py`](../../apps/backend/replay.py) | Retained video segments, time mapping, telemetry history and preview backup |
| Player controller | [`apps/web/src/player.js`](../../apps/web/src/player.js), [`apps/web/src/replay.js`](../../apps/web/src/replay.js) | One media element, playback state and live-relative timeline |
| UI elements | [`apps/web/src/components/`](../../apps/web/src/components/) | Light-DOM Web Components and accessible player interactions |
| Transport and lifecycle | [`apps/web/src/video-stream.js`](../../apps/web/src/video-stream.js), [`apps/web/src/updates.js`](../../apps/web/src/updates.js) | Continuous video response, SSE metadata, recovery and fallback |
| Backend providers | [`apps/web/src/backend/`](../../apps/web/src/backend/) | Selected-origin Python transport or browser-only media and simulated demo data |
| Print events | [`apps/web/src/timeline-events.js`](../../apps/web/src/timeline-events.js) | Observed state transitions mapped onto retained video time |
| Local previews | [`apps/web/src/preview-history.js`](../../apps/web/src/preview-history.js), [`apps/web/src/preview-storage.js`](../../apps/web/src/preview-storage.js) | Sample decoded frames, bounded RAM/IndexedDB and session cleanup |

## Data flow

With the Python provider:

1. The server scans configured private subnets for approved camera ports. Bounded
   manufacturer checks identify a supported printer before it appears in the list.
2. A saved LAN code belongs to that printer. A provider opens its camera feed and
   local telemetry connection. Access codes stay on the server.
3. FFmpeg remuxes compatible H.264 by default. The DVR retains temporary session
   history. A continuous binary response feeds the browser; HLS is a compatibility fallback.
4. The browser uses a native video decoder and hls.js's media worker. SSE carries
   metadata changes rather than repeated polling in the normal path.
5. Decoded stills are captured locally for quick scrub previews. Missing stills
   can fall back to server sprite sheets; the server still supplies actual rewind video.
6. Telemetry snapshots map to the recorded video clock. Previewing a position
   does not repeatedly restart video; the seek commits after the gesture.

## State and compatibility

Persistent printer identity and access codes live in `/data`; temporary video
history lives in `/buffer`. Browser preview images use bounded session-local
storage. See [local preview retention](../local-previews.md) and
[telemetry history](../printer-telemetry.md) for limits and clocks.

Existing `printer-camera` storage/cache namespaces and `printer-*` custom-element
tags remain stable across the product rename. They are migration interfaces,
not user-visible branding. The Bambu namespace remains a manufacturer adapter.

The app does not issue printer commands today. The fake-camera server used in
CI generates footage and telemetry; it never discovers a real device.
