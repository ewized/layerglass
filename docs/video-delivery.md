---
title: Continuous video delivery
tags: [technical]
---

# Continuous video delivery

[Vault home](index.md)

The old transport used HLS's normal request cycle: reload `live.m3u8`, then GET
each new `.ts` segment. Those were video requests, separate from the metadata
polling already replaced by SSE. A codec change does not remove that cycle.

The recorder still shares one FFmpeg connection per printer and copies the
printer's H.264 stream by default. Temporary archives, retention limits and the
per-page recording start remain the same. The delivery layer now pushes bytes
over a persistent HTTP response, using hls.js's documented custom-loader API
to retain its TS-to-MP4 transmuxing, timestamp handling, seekable range and
existing player controls. Compressed video reaches the native browser decoder
and renderer through MediaSource, allowing the browser to use its hardware
decoder when supported by the device and codec. hls.js does not decode the
video in JavaScript. The main picture stays on the native video element.

Stopping or replacing an HLS relay removes its final temporary live window after
FFmpeg exits, including reconfiguration and forgetting a printer. Previously
issued URLs for that window then return 404. Cleanup is limited to the stopped
relay's generation; other live relays and retained page archives have separate
ownership.

If initial page-history collection or metadata fails, creation releases the
unreturned page lease and prunes unused archives. A later retry can succeed
without waiting for lease expiry or consuming the viewer limit. Other pages
keep their existing shared archive and history.

Page creation checks printer admission under the DVR lock, using the same
replay-to-registry lock order as collection. Forgetting a printer removes its
registry binding before pruning its page leases: a concurrent create either
finishes before that pruning or rejects the removed binding afterward. It cannot
restore a page archive after forget completes.

Source-filename deduplication retains only names in the relay's current rolling
manifest, so this bookkeeping stays bounded even during a long uninterrupted
recording. A new relay generation resets those names while preserving retained
page history, discontinuities and each page's starting boundary.

The application loads native ES modules through one `type="module"` entry.
Its hls.js ESM dependency uses the pinned standalone `hls.worker.js` for
transmuxing. Both files and source maps come from the same integrity-verified
upstream package; their hashes are recorded in `apps/web/src/vendor/VERSION.json`.

## Wire format and flow control

`GET /replay/<page-session>/video[?start=<sequence>]` is a close-delimited
`application/octet-stream` response with `Cache-Control: no-store, no-transform`
and `X-Accel-Buffering: no`. It starts with four ASCII bytes `BCV1`. Each record
has two unsigned big-endian 32-bit lengths, UTF-8 JSON, then optional binary
media bytes. This is an app-specific framing format; it is not a new codec.

- `index` supplies descriptors for retained footage belonging to this page.
- `update` supplies new descriptors and current retention bounds. Old index
  entries are removed when the archive cap trims footage. Growing playlist
  text is generated locally rather than retransmitted on every refresh.
- `segment` carries the original TS bytes and their sequence number.
- `heartbeat` keeps an idle connection alive every 15 seconds.

The browser gives generated playlists and cached segment bytes to hls.js
asynchronously. It reports memory-read timings rather than inventing a network
bandwidth measurement. Payloads passed to its worker are copies, since transfer
would detach the retained ArrayBuffer. Stats displays the measured encoded
media bit rate (fragment bytes / media duration) separately from network speed.

A small initial burst allows normal decoder prefetch. Archived fragments are
then paced at 1×, while new live fragments leave as they become available.
The browser retains at most 24 fragments / 16 MiB, except one individually
larger fragment up to 32 MiB. The parser rejects larger records and JSON headers
over 8 MiB. Cache eviction does not discard the disk archive. A seek outside
the cache opens a replacement response starting at that sequence, so both
Live and replay avoid recurring segment GETs. A reconnect also sends a fresh
index and preserves this page's archive, including timestamp discontinuities.

The handler looks up only this page's permitted fragments under the recorder
lock, then releases it before file/socket IO. Socket writes time out after
five seconds; server shutdown and session release end the response. The
frontend cancels old responses on camera changes, navigation, backgrounding,
seek repositioning and player replacement. No footage is stored in localStorage,
IndexedDB or a service worker.

## Mobile playback work and memory

hls.js uses a 12-second forward-buffer target, a 24-second maximum forward
target, an 8 MiB encoded-buffer target, and a 12-second back buffer. Non-contiguous
forward ranges more than 24 seconds away are evicted after seeking. Segment
boundaries and browser-managed eviction can change the actual retained amount;
these targets do not cap total browser, compositor, or decoder memory. Full page
history stays in the server archive, independent of playback buffer eviction.

The browser renders frames directly. The application samples native frame
progress through `timeupdate`, `loadeddata`, and `playing` events for stall
recovery, avoiding a JavaScript frame callback for every displayed frame. It
writes the loading overlay only when entering playback/recovering. The
decorative diffusion keeps its existing small, throttled samples from that
same native video element. Stats samples only while open.

Stats identifies the decoder as browser native and reports hls.js/MediaSource
as the media pipeline. Its codec comes from actual buffer codec metadata.
There is no portable HTML video API that forces a hardware decoder or reveals
the exact active decoder backend on every phone. MediaCapabilities predictions
can describe power efficiency but do not prove which decoder is currently
active. Hardware/battery behavior requires verification on the physical phone;
desktop WebKit with a mobile viewport does not establish that result.

## Compatibility and recovery

hls.js supports custom loaders over browser MediaSource APIs. WebKit introduced
ManagedMediaSource on iPhone in Safari 17.1; it requires an AirPlay alternative
or remote playback disabled. After hls.js attaches its blob source, the app
adds a network HLS alternative and enables AirPlay. That alternative remains
unfetched during local continuous playback. Safari without ManagedMediaSource
uses native HLS when available. The app uses
feature detection, preserving native HLS on older Safari and ordinary hls.js
delivery on browsers without streamed fetch responses.

Desktop Chrome's Cast button uses Google's sender SDK with the viewer's HTTPS
HLS URL. Its generic `video.remote.prompt()` path cannot initiate casting from
the MediaSource blob used for local continuous playback. The SDK loads once
ahead of the click so the browser picker receives its user activation. Safari
keeps `webkitShowPlaybackTargetPicker()` and its HLS source alternative; other
supported native sources retain `video.remote.prompt()`.
Receivers need to reach the HLS URL. Active casting keeps SSE and the DVR session
lease alive when backgrounded; the stall watchdog does not restart remote
playback. Google's receiver controls drive the shared timeline and printer
history clock while local decoding is paused. Disconnect restores that decoder
and recording session. Read-only receiver CORS is limited to HLS playlists and
segments. See [casting.md](casting.md) for the SDK boundary and validation.

Media Session publishes the model/ID and app artwork, playback state, and
play/pause, seek and native PiP actions. While following Live, the native media
duration is `Infinity`. On MediaSource/ManagedMediaSource, paused and rewound
footage uses the available recording's duration so native PiP stops marking it
LIVE. Returning to Live restores infinite duration. Changes wait for active
SourceBuffer appends and include all buffered frames to avoid trimming footage
or moving the playhead. Resuming a native pause keeps replay selected.
The browser owns the position clock directly;
JavaScript does not call `MediaSession.setPositionState()`, which substantially
reduced frame delivery in desktop WebKit testing. Unsupported actions degrade
independently. Chrome's audio-focus policy can omit video-only feeds from Global
Media Controls until native PiP or remoting is active. Metadata cannot force a
card to appear; no synthetic audio or extra player is added.

References: [WebKit's MSE/AirPlay source alternatives](https://webkit.org/blog/15036/how-to-use-media-source-extensions-with-airplay/),
[Media Session](https://web.dev/articles/media-session), and
[Chromium's media-session admission rules](https://github.com/chromium/chromium/blob/main/content/browser/media/session/media_session_controller.cc#L251).
Chromium's native PiP [uses infinite duration to select its LIVE indicator](https://github.com/chromium/chromium/blob/main/chrome/browser/ui/views/overlay/video_overlay_window_views.cc#L2201).

Streaming failures retry after one and two seconds. Three consecutive failures
temporarily fall back to HLS; a valid media record resets that failure count so
separate short interruptions cannot accumulate into permanent fallback. A
first-byte watchdog detects buffering proxies; ongoing responses allow the
heartbeat interval. Fatal decoder/playback errors rebuild continuous playback
without changing its protocol. Automatic rebuilds of the same recording keep a
paused replay frame paused, or resume playing replay from its selected position.
hls.js starts loading that recorded position after the continuous response's
initial media burst; native playback restores it after metadata. A manifest alone
does not complete restoration: the selected frame must be decoded and its seek
finished. Paused restoration suppresses native autoplay. Retention can clamp an
expired position to the earliest available frame; explicit Live or a new session
supersedes a pending historical restoration. While media loads, the displayed
replay clock holds its selected position instead of resetting to zero.

Hidden pages stop hls.js loading and cancel loader
deadlines as well as the fetch reader; intentional suspension must not become a
fatal fragment timeout. Visibility restoration resumes paused/replayed footage
with its original recording session. Native PiP and Cast keep their existing
visibility/remote-playback behavior.
If recovery is still waiting for its first media fragment, that transport's
initializer also waits through hidden/offline readiness deadlines. It constructs
the decoder only after foreground network delivery resumes. Transport replacement
or a session/camera change cancels the old initializer; its late readiness or
failure callback cannot attach media to the replacement recording.

During HLS fallback, a foreground Live viewer schedules a quiet probe after one
minute. It must receive at least two media fragments before replacing the working
player. That connected response and cache become the active transport, avoiding
a second connection for the upgrade. A rejected/buffered probe leaves HLS and
its decoder untouched; further probes back off to two, four, eight and fifteen
minutes, with a ten-second per-probe deadline and no nested transport retries.
Hidden/offline pages, pagehide, printer changes and Cast cancel probes. Replayed
or paused footage is not advanced to Live by an upgrade. The explicit Refresh
viewer action also clears fallback. Unsupported legacy browsers keep native HLS.
HLS fallback and native JPEG feeds still have recurring media requests. The
metadata subscription remains SSE, with its existing combined HTTP fallback when
SSE is unavailable.

This changes HTTP request overhead, not the encoded video bit rate, resolution,
frame rate or camera keyframe delay. No second encoder, media gateway, WebRTC
ports, or third-party runtime dependency is added. HTTP/2 Push does not replace
a continuous video transport and is no longer supported in Chromium.

## Validation and measurements

Before deployment, a 30-second measurement of the existing live printer made
15 playlist requests and 14 segment requests while playing 28.1 seconds of
video. The initial continuous-stream fixture measurement played 20 seconds
with zero additional media requests after its one video connection opened.
The browser integration suite asserts the same behavior in Chromium and WebKit,
including old footage after cache eviction, streaming 1× replay, Live, paused
reconnection, visibility changes and compatibility fallback.
`apps/web/tests/browser-replay-recovery.js` additionally checks paused and playing
replay through decoder rebuilds, continuous-to-HLS failure recovery and native
file reattachment. It verifies recorded telemetry clocks, one restoration seek
and explicit Live during loading.
`apps/web/tests/browser-replay-suspension.js` holds initial media through an
accelerated readiness deadline, then verifies real decoded paused/playing replay
after visibility and offline lifecycle restoration. It also checks explicit Live,
session replacement and camera cancellation. Visibility/network flags and the
45-second deadline are controlled by the fixture; media clocks and decoding are
not accelerated.
These are generated-media checks in headless Chromium/WebKit; native Safari HLS
and physical-device recovery remain device checks. Unit/HTTP tests
exercise record parsing, memory limits, decoder buffer transfer, retention,
page isolation, reconnects, pacing, aborts and shutdown.

After deployment, separate 30-second measurements against the same live printer
with Stats for nerds open gave:

| Browser / delivery | New media requests during measurement | Video clock advancement | Resolution |
|---|---:|---:|---|
| Chromium / previous HLS | 29 (15 playlists + 14 fragments) | 28.1 s | unchanged source |
| Chromium / continuous HTTP | 0 (one response opened at startup) | 28.0 s | 1920 × 1080 |
| WebKit / continuous HTTP | 0 (one response opened at startup) | 29.0 s | 1920 × 1080 |

Both continuous responses remained connected; the application media cache was
8,320,128 bytes at the end of each measurement. There were also no recurring
status, catalog or replay-metadata requests. All 54 JavaScript unit tests and
40 Python/HTTP tests passed, along with Chromium/WebKit browser checks for
video delivery, replay/timeline, settings, SSE recovery, reload, rotation and
player controls. WebKit testing uses its desktop test engine with a mobile
viewport; it does not substitute for testing a physical iPhone.

Artifacts are in `test-results/video-stream/`. The reproducible measurement
script is `apps/web/tests/measure-network.js`; it counts real browser requests while
also measuring video clock advancement.

The mobile performance update was checked against the live 1920 × 1080 H.264
feed on 2026-10-23. In two six-second Chromium measurements, steady loading
overlay writes changed from 104 to zero while native video frames continued
advancing. This counts removed UI operations, not CPU time or battery drain.
A subsequent 20-second WebKit measurement with Stats open advanced the video
clock by 19.7 seconds with zero additional requests. The configured printer
remained in copy mode. Artifacts are in `test-results/mobile-performance/`.

The updated Chromium/WebKit video-delivery suite additionally asserts that
native frames continue advancing with zero steady loading-overlay writes,
and verifies the decoder/pipeline/codec diagnostics. Existing old-footage seeks,
Live, paused reconnects, background resume, native HLS fallback, settings, real
Document/video PiP, and all 63 JavaScript unit tests passed.

## Primary sources

- [HLS RFC: client playlist reload behavior](https://www.rfc-editor.org/rfc/rfc8216#section-6.3.4)
- [hls.js 1.7.3: custom loaders and statistics](https://github.com/video-dev/hls.js/blob/v1.7.3/docs/API.md#creating-a-custom-loader)
- [hls.js 1.7.3: ManagedMediaSource attachment](https://github.com/video-dev/hls.js/blob/v1.7.3/src/controller/buffer-controller.ts)
- [WebKit: ManagedMediaSource on iPhone](https://webkit.org/blog/14735/webkit-features-in-safari-17-1/)
- [W3C: MediaSource Extensions](https://www.w3.org/TR/media-source-2/)
- [hls.js: native video decoding and rendering](https://github.com/video-dev/hls.js)
- [hls.js: buffer sizes and durations](https://github.com/video-dev/hls.js/blob/v1.7.3/docs/API.md#maxbufferlength)
- [W3C: Media Capabilities and power efficiency](https://www.w3.org/TR/media-capabilities/#media-capabilities-information)
- [Chrome: removal of HTTP/2 Server Push](https://developer.chrome.com/blog/removing-push)
