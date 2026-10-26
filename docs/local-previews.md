---
title: Local scrub previews
tags: [technical]
---

# Local scrub previews

[Vault home](index.md)

The playing native video supplies one 320 × 180 JPEG per five-second bucket.
A `timeupdate` gate requests one presented-frame callback, uses its `mediaTime`,
draws the existing decoded frame to a detached canvas, and calls asynchronous
`toBlob('image/jpeg', 0.6)`. This avoids another network stream/decoder and a
per-frame JavaScript loop. JPEG image mode can capture its existing image too.
Capture pauses when the page/player is hidden or playing remotely. It cannot
reconstruct video the browser has not decoded while paused or in the background.

`apps/web/src/preview-history.js` keeps compressed JPEGs in a 32 MiB LRU, with bounded
24-hour/five-second metadata. At 20 KiB per image, 45 minutes is 540 images and
about 10.3 MiB. Actual image sizes depend on the scene. `apps/web/src/preview-storage.js`
backs this with IndexedDB: at most 128 MiB / 20,000 records across page sessions,
also capped to 10% of the origin's reported remaining storage. These are app
budgets, not promises that the browser will provide that space. Pending writes
are bounded to eight. Quota failures disable disk writes and retain bounded RAM.

Disk stores compressed JPEG ArrayBuffers, not base64 or file-backed Blobs. The
binary format avoids WebKit's Blob preparation failure path observed in browser
testing. Blob reconstruction happens only on reads. ArrayBuffer conversion starts
immediately, before waiting for the database to open: a queued WebKit read can
otherwise outlive the page-owned Blob during navigation. Pending FileReader reads
are aborted on page exit and storage resumes on a restored page. Conversion also
finishes before creating an IDB transaction, so an asynchronous conversion cannot
allow Safari to auto-commit an otherwise idle transaction. Reads coalesce per
asset. Each tab has its opaque page-session namespace; a newly loaded page never
reuses another page's footage. Closing/changing the session removes its records;
abandoned records expire after 24 hours. Cleanup is best effort on page exit.

`apps/web/src/components/scrub-preview.js` paints local JPEGs to one canvas. Decoded
ImageBitmaps are independently capped to 8 MiB and closed on eviction/reset.
Rapid movement coalesces decoding toward the latest target. A real still remains
visible during a disk read/decode; the label uses that still's timestamp, with
`≈` when it is more than five seconds away from the requested position. The
timestamp stays below the complete image. There is no preview loading spinner.

Missing, evicted or unreadable local frames fall back to the existing server
sprite endpoint, after local lookup and a short pointer debounce. One JPEG has
six five-second frames. Its cells are cached locally alongside captured frames;
a late server reply cannot replace a captured frame or the current pointer's
preview. There is one backup HTTP request at a time and a ten-second failure
cooldown, including when a returned sprite cannot be decoded. A failed captured
frame can still use a different server sprite. There is no automatic HTTP
prefetch/poll loop. Capture continues collecting the live session even while
the preview is closed.

Stills do not replace video recording. Full-motion rewind beyond the bounded
native video/segment cache still uses the server DVR. Browser storage can be
reclaimed; a phone cannot guarantee an unlimited or always-complete local
history. The fallback covers those gaps without affecting the playing decoder.
Thumbnail media storage is independent of the service worker: development
app-shell caching remains disabled, so reloads continue fetching fresh code.
Copy debug info includes local preview counts, byte budgets and cache hits.

## Primary sources

- [web.dev: requestVideoFrameCallback](https://web.dev/articles/requestvideoframecallback-rvfc):
  synchronization with presented frames and use of the frame's media timestamp.
- [MDN: canvas toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob):
  asynchronous compressed image encoding, quality, null results and origin limits.
- [WebKit: storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/):
  estimated quota, best-effort eviction and handling storage failure.
- [MDN: storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria):
  bounded origin storage, quota exceptions and why localStorage is inappropriate
  for many binary thumbnails.
- [MDN: structured clone types](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm):
  IndexedDB supports binary ArrayBuffer values without base64 expansion.
- [WebKit Blob storage issue](https://bugs.webkit.org/show_bug.cgi?id=188438):
  the Blob preparation failure family; our observed WebKit error is handled by
  storing JPEG bytes, without assuming that every Safari release has this bug.

## Verification

Node tests cover a simulated 45-minute history, memory/disk eviction, write
backpressure, stale sessions, exact capture timestamps and cancellation. Browser
tests use actual decoded fixture video and IndexedDB in Chromium and WebKit.
The accelerated 45-minute test checks every five-second timestamp and image
color with no preview HTTP requests or main-video seeks; it is not a claim of
a 45-minute physical-phone soak test. Separate checks force RAM eviction, quota
errors and delayed server fallback, and exercise keyboard/touch/narrow layouts.
