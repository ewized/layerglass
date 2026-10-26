---
title: Testing
tags: [development, testing]
---

# Testing

[Vault home](../index.md) · [Workflow](workflow.md)

`./scripts/check.sh all` builds the runtime image, runs all Python and JavaScript
unit tests, validates documentation/version metadata, starts a generated-camera
fixture, and runs representative Chromium/WebKit regressions. It needs Docker,
not a printer or host-installed language toolchains. `unit` and `browser` modes
run the corresponding portion. Logs and screenshots go to ignored `test-results/`.
The complete run also builds the Nx backend/web/site projects twice to verify
cache restoration and exports `test-results/project-graph.json`. `workspace`
mode runs that packaging/graph/documentation check by itself.
The independent `site:test` target writes screenshots into its checkout's
`test-results/` directory. `LAYERGLASS_SITE_TEST_RESULTS` selects another output
directory; the temporary-copy workspace harness defaults it to the mounted
artifact collector so those screenshots survive container cleanup.
Pass representative suite names to focus a browser run, for example
`./scripts/check.sh browser browser-scrub-commit.js browser-components.js`.

| Change | Focused coverage |
| --- | --- |
| Approved devices, discovery/backoff, credentials | `test_providers.py`, `test_identification.py`, `test_discovery_cache.py`, `test_cameras.py`, `test_printer_bindings.py` |
| MQTT data and replay time | `test_printer.py`, `test_public_telemetry.py`, `test_printer_history.py`, `printer-history.test.js`, `printer-stats.test.js` |
| Video transport and DVR | `test_video_stream.py`, `test_replay.py`, `video-stream.test.js`, browser video-stream/stream-recovery/replay-recovery/replay-suspension suites |
| Live-relative timeline and gesture commits | `timeline.test.js`, `scrub-preview.test.js`, browser scrub-commit suite |
| Observed print-event markers | `timeline-events.test.js`, browser timeline-events suite |
| Backend selection and CORS | `backend.test.js`, `test_backend_cors.py`, browser backends/backend-origin suites |
| Direct printer admission and live-only MJPEG | `direct.test.js`, browser direct suite (generated HTTP multipart media, no printer) |
| Local thumbnail retention, storage and loading | `preview-history.test.js`, `browser-preview-storage.js`, `browser-preview-buffer.js`, `browser-preview-loading.js` |
| Media/platform UI | `media.test.js`, `cast-sender.test.js`, browser fullscreen/Google Cast suites |
| Modules and UI ownership | `browser-module.js` helpers, browser ESM/components suites |
| Keyboard focus and pending editors | `browser-keyboard-focus.js` (Chromium/WebKit keyboard navigation, Stats, onboarding cancellation and rejected setup) |
| Shell/update behavior | `test_pwa.py`, `pwa.test.js`, browser PWA suite |

The selected browser list is maintained in [`apps/web/tests/run-browser.js`](../../apps/web/tests/run-browser.js).
Each suite has a bounded timeout. It includes real native-video decoding,
pause/resume, media-worker continuity, SSE/recovery, real IndexedDB reads and
writes, and a 540-point simulated 45-minute thumbnail sweep with zero preview
HTTP requests. The accelerated sweep proves retention/mapping, not 45 minutes
of wall-clock capture or physical phone performance.
Timed streaming/recovery checks run one engine at a time so their decoders do
not compete for runner CPU. Frame counters verify progress rather than a fixed
headless frame rate. See [Playwright's CI guidance](https://playwright.dev/docs/ci)
on limiting concurrency for reproducible checks.
The fixture explicitly trusts only its second loopback origin for the selected
backend check. This exercises native video, SSE and protected POSTs across
origins; deployment defaults still trust no hosted origin until configured.

The transport regression includes forward seeks that skip just one recorded
fragment. Those seeks must reposition the paced archive response immediately;
ordinary consecutive playback keeps the existing response. The browser checks
also verify that returning to Live reaches the current edge without recurring
playlist or segment requests.

## Focused commands

For an individual Python file, use a built runtime image and mount the checkout
read-only (substitute the daemon-visible path if different):

```sh
docker build -t local/layerglass-test .
docker run --rm --init --name codex__layerglass_python_focus \
  -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/app/apps/backend \
  -v "$PWD:/app:ro" -w /app/apps/backend \
  local/layerglass-test python -B -m unittest discover -s tests -p test_discovery_cache.py -v
docker image rm local/layerglass-test
```

`apps/web/tests/run-js.sh` copies sources into a temporary directory, installs locked npm
dependencies there, and runs `npm test` by default. Append a script such as
`apps/web/tests/browser-esm.js` for a focused browser run. Use the pinned Playwright image
from `scripts/check.sh`. Point `VIEWER_URL` at the generated fixture, ideally
`http://127.0.0.1:8080` in its shared Docker network namespace for secure-context
storage/service-worker checks. No `node_modules` directory is written to the checkout.

The default CI PWA run verifies network-only development mode. Full offline
update/rollback checks in `browser-pwa.js` require a separate fixture with
`FIXTURE_PWA=1` and `PWA_CACHE_ENABLED=1`, and `FIXTURE_PWA=1` in the browser
container. Do not enable caching in the normal dev stack just to run those checks.

## Hardware and opt-in checks

`check_live_discovery.py`, `benchmark_discovery.py`, `browser-discovery-live.js`
and `browser-scrub-preview-live.js` are manual integration tools, excluded from
the automatic suite. Set their target/scope explicitly before running them.
Do not point CI at a personal deployment or attach public PR jobs to a LAN runner.

Native iPhone fullscreen/PiP/AirPlay, browser media panels, real Cast receivers,
physical hardware acceleration and actual printer firmware need device checks.
The Cast suite stubs Google's sender SDK while exercising real local media;
it cannot prove receiver playback. Record results in the
[device checklist](../product/roadmap.md).
