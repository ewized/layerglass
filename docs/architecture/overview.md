---
title: Architecture
tags: [architecture]
---

# Architecture

[Vault home](../index.md)

LayerGlass keeps its established Python modules and native ES modules inside
an [Nx workspace](workspace.md). The Python backend, demo backend, local backend, player and marketing site have
independent Nx targets. The backend can still serve the
browser application together in one Docker container.
An explicit [backend provider](backend-providers.md) selects that service or an
entirely browser-run demo/local video. Standalone hosting first asks for a backend;
the Python-served viewer defaults to its own backend.

| Part | Source | Responsibility |
| --- | --- | --- |
| HTTP application | [`app.py`](../../apps/python-backend/app.py) | Configuration, routes, relay lifecycle, SSE and static shell |
| Printer registry | [`cameras.py`](../../apps/python-backend/cameras.py), [`identity.py`](../../apps/python-backend/identity.py) | Known printers, per-printer credentials, identity and relay ownership |
| Discovery | [`discovery.py`](../../apps/python-backend/discovery.py) | Bounded camera-port scans, identity races, caching and backoff |
| Manufacturer adapters | [`apps/python-backend/providers/`](../../apps/python-backend/providers/) | Approved profiles, transport setup, identity and read-only telemetry |
| Session DVR | [`replay.py`](../../apps/python-backend/replay.py) | Retained video segments, time mapping, telemetry history and preview backup |
| Player controller | [`apps/layerglass/src/player.ts`](../../apps/layerglass/src/player.ts), [`apps/layerglass/src/replay.ts`](../../apps/layerglass/src/replay.ts) | One media element, playback state and live-relative timeline |
| UI elements | [`apps/layerglass/src/components/`](../../apps/layerglass/src/components/) | Light-DOM Web Components and accessible player interactions |
| Transport and lifecycle | [`apps/layerglass/src/video-stream.ts`](../../apps/layerglass/src/video-stream.ts), [`apps/layerglass/src/updates.ts`](../../apps/layerglass/src/updates.ts) | Continuous video response, SSE metadata, recovery and fallback |
| Backend selection | [`apps/layerglass/src/backend/`](../../apps/layerglass/src/backend/) | Provider choice and the selected-origin Python HTTP client |
| Browser backends | [`demo-backend`](../../apps/demo-backend/), [`local-backend`](../../apps/local-backend/) | Independent simulated and direct/local browser transports |
| Print events | [`apps/layerglass/src/timeline-events.ts`](../../apps/layerglass/src/timeline-events.ts) | Observed state transitions mapped onto retained video time |
| Local previews | [`apps/layerglass/src/preview-history.ts`](../../apps/layerglass/src/preview-history.ts), [`apps/layerglass/src/preview-storage.ts`](../../apps/layerglass/src/preview-storage.ts) | Sample decoded frames, bounded RAM/IndexedDB and session cleanup |

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
