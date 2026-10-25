---
title: Installable camera viewer
tags: [technical]
---

# Installable camera viewer

[Vault home](index.md)

The manifest at `/manifest.webmanifest` uses a stable `/` identity and start URL,
standalone display, unrestricted orientation and the existing dark player theme.
Opaque 192/512 px PNG icons, a maskable 512 px icon and an Apple 180 px touch icon
come from `apps/web/src/icons/icon.svg`. The printer/play mark stays inside the
maskable safe area. Safari home-screen metadata and the existing safe-area CSS
support the iPhone player without adding installation UI to the video.

`apps/web/src/pwa.js` registers the root `/service-worker.js` as a native module after
the page loads, only in secure contexts. Unsupported browsers and plain LAN HTTP
continue using the player normally. All dependencies are local; there is no new
package, bundler, CDN or JavaScript video decoder.

## Development mode (default)

`PWA_CACHE_ENABLED=0` keeps the installed app network-only during active
development. There is no fetch interception or precaching. The HTTP server sends
`Cache-Control: no-store` for the HTML, modules, CSS, manifest and icons as well
as private API/media responses. Reloading requests the deployed files directly.

The development worker calls `skipWaiting()` and claims existing clients so an
older cache-first worker cannot keep serving a stale release. Activation deletes
only caches whose names begin with `printer-camera-shell-`; unrelated caches,
preferences and the server's page video buffers are preserved. It does not reload
an open player. After the switch is installed, the next reload uses fresh files.

PWA installation, icons and standalone display remain available. A fresh launch
needs the server to be reachable. Set `PWA_CACHE_ENABLED=1` in the Compose
environment and recreate the viewer to restore the offline shell described below.

The player separately keeps requested session thumbnails in RAM/IndexedDB for
fast scrubbing. This stores compressed media bytes, never app code or responses
in Cache Storage, and does not make reloads serve stale code. Session cleanup,
limits and quota fallback are described in [local-previews.md](local-previews.md).

## Optional offline storage boundary

`apps/web/src/pwa-shell.js` is the complete, explicit allowlist of public UI files.
The worker answers only GETs for those exact same-origin URLs without a query
or Range header. It never intercepts commands, API/SSE, streaming video, HLS,
JPEG frames, other sites or arbitrary static paths. No runtime response cache
can accidentally retain access codes, printer metadata or footage. The server
continues sending `no-store` for API and media responses.

The entire shell is served from one release cache, including navigation. This
avoids mixing newly fetched HTML with old cached modules. Opening the installed
app offline shows the normal controls and a connection-off icon with an
accessible status message. Native offline events suspend metadata/video retries
and pause playback. Online events reconnect the same page session and resume
playback if it was playing; a deliberate pause is preserved. A fresh offline
launch waits for connectivity before requesting any catalog or stream.

This is an offline UI, not offline camera recording. The existing server DVR
lease/retention rules still apply, and iOS may reclaim cached website storage.

## Updates with offline caching enabled

At server startup, `app_shell_revision()` hashes the shipped static filenames
and contents (excluding source maps). The HTTP handler injects this revision
into the root worker source, so a deployment changes the worker without a manual
version counter. Public shell responses carry `X-App-Shell-Revision`.

Installation fetches every allowed asset, verifies the matching revision and
stores one complete release. Any failed request, interrupted deployment or
storage failure rejects the install and removes the partial new cache. Existing
working releases stay available. Registration uses `updateViaCache: 'none'` so
browser HTTP caching cannot hide a worker update.

With caching enabled, the worker follows the normal waiting lifecycle. It never forces
`skipWaiting()` or a reload during playback. Once every old app window/tab closes,
the ready release activates, removes only this app's older shell caches and
claims clients. Another application's Cache Storage entries are preserved.
Reopening then uses the new release. OS eviction falls back to a normal network
request; it does not silently cache a mismatched release.

## Verification and references

Unit tests check the storage boundary, complete module graph, revision behavior,
manifest headers and icon dimensions. Browser tests install real module workers
in Chromium and WebKit over secure localhost, exercise cold offline navigation,
resume the same server buffer after a network change, and simulate both a good
release and a failed deployment while the player remains open. Start that fixture
with `FIXTURE_PWA=1` and `PWA_CACHE_ENABLED=1`. The same tests then disable caching,
verify immediate migration without interrupting playback, preserve an unrelated
cache, and check that consecutive reloads fetch the latest HTML and CSS directly.
For a network-only deployment, run `apps/web/tests/browser-pwa.js` with
`PWA_CACHE_ENABLED=0` in the browser test container; it checks a fresh install,
empty app caches, network responses on reload, and native video playback.

Playwright 1.61's WebKit offline emulation has a
[known navigation bug](https://github.com/microsoft/playwright/issues/42775).
Its cached-navigation test disables the fixture backend and supplies matching
offline state instead; live connection loss/recovery still uses the browser's
offline emulation. Chromium runs full cold-offline navigation directly.

Physical home-screen installation and OS background/lock behavior require the
phone itself; browser emulation does not establish those results.

- [Service worker lifecycle](https://web.dev/articles/service-worker-lifecycle)
- [Web app manifest](https://www.w3.org/TR/appmanifest/)
- [Safari Add to Home Screen](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)
