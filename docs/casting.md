---
title: Browser casting
tags: [technical]
---

# Browser casting

[Vault home](index.md)

Desktop Chrome's native Remote Playback API is exposed even when the current
media cannot use its remoting backend. The app's continuous stream plays through
a MediaSource blob. Chromium's remoting compatibility check accepts network/file
sources; an incompatible source leaves no presentation URL and `prompt()` can
reject as dismissed without opening a picker. Merely checking that `prompt`
exists does not establish that the streamed source can be cast.

`apps/web/src/cast-sender.js` is an ESM adapter around Google's Web Sender SDK. On
secure Chromium browsers with the Presentation API, it loads the vendor SDK
once when HLS attaches, before a user clicks Cast. Safari is excluded and keeps
its native AirPlay path. The required `__onGCastApiAvailable` callback and vendor
globals are confined to this boundary; application code remains ESM.
If that initial load fails or times out, its script and callback are cleaned up.
**Refresh viewer** can try loading the SDK again on the same page after
connectivity returns. Concurrent initialization shares one attempt; there is no
SDK retry timer. A successfully prepared sender keeps its existing listeners.

The custom Cast button invokes `CastContext.requestSession()` directly in its
click event. A selected receiver loads the same-origin network HLS URL using
Google's Default Media Receiver, without an application registration. Only
server-issued replay/relay playlist paths are accepted. It receives the model,
printer ID and icon, stream type LIVE, and either the live edge or the selected
replay time/paused state. RTSP URLs and printer access codes are never sent.

The existing video and its decoder keep playing while the picker is open.
Cancellation, SDK failure or a receiver load failure leaves them in place. After
a successful receiver load, the local video pauses and `PageReplay` uses the
receiver clock/control adapter. The same buttons, timeline and Media Session
actions control remote play/pause, seeking and Live. Printer history uses that
clock, rather than the paused local decoder's program date. Cast connection
events preserve background SSE and the recording lease. Disconnect restores the
existing local decoder and buffer. Changing/forgetting a printer ends the owned
cast; a late picker result cannot load the previous printer. Session joining is
tab scoped, with automatic saved-session resumption disabled.

Receiver fetches require CORS. The server permits cross-origin GET/HEAD and
read-only OPTIONS only for HLS `.m3u8` and `.ts` paths. Credentials are not
enabled. APIs, telemetry, access-code management, previews and the binary
browser stream retain their existing origin restrictions. Media preflights may
acknowledge private-network access. The page CSP permits the official gstatic
sender scripts and the loader's two official extension fallbacks, retaining
same-origin connection policy and excluding inline scripts and eval. The
receiver needs network access to the viewer URL and a trusted certificate.

Validation:

- Unit tests cover synchronous picker calls, network URL/metadata, live versus
  replay, cancellation, load failures, receiver commands, stale picker results,
  disconnect and source validation.
- Chromium tests run real native playback and the app's actual SDK loader with
  an external-script boundary fixture. They verify remote toolbar/Media Session
  actions, no local video-start requests from remote seeking, background capture,
  original decoder/history restoration, real cross-origin playlist/segment
  fetches, unreadable API responses and blocked-SDK recovery. The isolated
  synthetic receiver is granted loopback access in the test profile.
- Existing Chromium/WebKit tests cover native casting and Safari's unfetched
  ManagedMediaSource HLS alternative.
- A separate HTTPS check loads Google's real SDK under the production CSP and
  checks SDK readiness and a trusted request into Chrome's Cast API. Headless
  browser tests cannot establish physical receiver selection or TV decoding.
- The user confirmed successful playback on their TV on October 24, 2026.
  Physical iPhone AirPlay testing remains in [the device checklist](product/roadmap.md).

Primary references:

- [Chromium remoting compatibility](https://raw.githubusercontent.com/chromium/chromium/main/media/remoting/renderer_controller.cc)
- [Chromium Remote Playback prompt implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/remoteplayback/remote_playback.cc)
- [Google Web Sender integration](https://developers.google.com/cast/docs/web_sender/integrate?hl=en)
- [Google Cast media and CORS requirements](https://developers.google.com/cast/docs/media)
