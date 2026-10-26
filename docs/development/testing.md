---
title: Testing
tags: [development, testing]
---

# Testing

[Vault home](../index.md) · [Workflow](workflow.md)

`./scripts/check.sh all` builds the runtime image, checks strict TypeScript in the
browser, service-worker, Node, edge and test environments, runs ESLint and Prettier, then
runs all Python and TypeScript
unit tests, validates documentation/version metadata, starts a generated-camera
fixture, and runs representative Chromium/WebKit regressions. It needs Docker,
not a printer or host-installed language toolchains. `unit` and `browser` modes
run the corresponding portion. Logs and screenshots go to ignored `test-results/`.
The complete run also builds all six Nx application/backend/contract projects twice to verify
cache restoration and exports `test-results/project-graph.json`. `workspace`
mode runs that packaging/graph/documentation check by itself.
The independent `layerglass-site:test` target writes screenshots into its checkout's
`test-results/` directory. `LAYERGLASS_SITE_TEST_RESULTS` selects another output
directory; the temporary-copy workspace harness defaults it to the mounted
artifact collector so those screenshots survive container cleanup.
Pass representative suite names to focus a browser run, for example
`./scripts/check.sh browser browser-scrub-commit.ts browser-components.ts`.

## TypeScript test sources

All unit tests, browser suites and test helpers are TypeScript. The dedicated
[`tsconfig.tests.json`](../../tsconfig.tests.json) applies the same strict compiler
options and checked indexing as the application. The
[source policy](../../scripts/check-typescript-only.ts) runs before typechecking
and rejects authored `.js`, `.mjs`, `.cjs` and `.jsx` files, including in copied CI
workspaces without a Git index. Installed dependencies and generated outputs are
excluded; the browser still receives compiled native ES modules.

Shared platform doubles live in [`tests/doubles.ts`](../../tests/doubles.ts),
and loopback HTTP helpers in [`tests/http.ts`](../../tests/http.ts). Model fake
methods and mutable state explicitly. `testDouble` checks a deliberately partial
platform implementation at fixture construction; assertions about application
results retain the actual production types. `untrustedInput` is reserved for
deliberately malformed wire data in validation/rejection tests. Do not use it to
bypass checking of valid fixtures. Non-null assertions require a local setup or
readiness invariant, or an explicit assertion about the value.

The browser fixtures under `apps/layerglass/tests/fixtures/` compile through
[`fixture-module.ts`](../../apps/layerglass/tests/fixture-module.ts) before being
served. Keep fixture scripts in checked TypeScript modules instead of untyped
JavaScript embedded in HTML strings. Playwright callbacks are checked as part of
their enclosing TypeScript suite; use its existing module-state helpers when
passing application handles into browser predicates.

| Change | Focused coverage |
| --- | --- |
| Approved devices, discovery/backoff, credentials | `test_providers.py`, `test_identification.py`, `test_discovery_cache.py`, `test_cameras.py`, `test_printer_bindings.py` |
| MQTT data and replay time | `test_printer.py`, `test_public_telemetry.py`, `test_printer_history.py`, `printer-history.test.ts`, `printer-stats.test.ts`, `browser-history-reconnect.ts` |
| Video transport and DVR | `test_video_stream.py`, `test_replay.py`, `video-stream.test.ts`, browser video-stream/stream-recovery/replay-recovery/replay-suspension suites |
| Live-relative timeline and gesture commits | `timeline.test.ts`, `scrub-preview.test.ts`, browser scrub-commit suite |
| Observed print-event markers | `timeline-events.test.ts`, browser timeline-events suite |
| Backend selection and CORS | `backend.test.ts`, `test_backend_cors.py`, browser backends/backend-origin suites |
| Direct printer admission and live-only MJPEG | `apps/local-backend/tests/direct.test.ts`, browser direct suite (generated HTTP multipart media, no printer) |
| Browser backend modules and public roots | `apps/demo-backend/tests/demo.test.ts`, `apps/local-backend/tests/file.test.ts`, `test_browser_modules.py`, static player smoke checks |
| Local thumbnail retention, storage and loading | `preview-history.test.ts`, `browser-preview-storage.ts`, `browser-preview-buffer.ts`, `browser-preview-loading.ts` |
| Media/platform UI | `media.test.ts`, `cast-sender.test.ts`, browser fullscreen/Google Cast suites |
| Modules and UI ownership | `browser-module.ts` helpers, browser ESM/components suites |
| Keyboard focus and pending editors | `browser-keyboard-focus.ts` (Chromium/WebKit keyboard navigation, Stats, onboarding cancellation and rejected setup) |
| Edge SSR and adoption | `infra/cloudflare/tests/rendering.test.ts`, local Wrangler checks, Lit identity/Emotion hydration checks in browser components |
| Delivery artifacts and public routing | `infra/cloudflare/tests/delivery.test.ts`, `hosting.test.ts`, local Wrangler checks |
| Shell/update behavior | `test_pwa.py`, `pwa.test.ts`, browser PWA suite |

The selected browser list is maintained in [`apps/layerglass/tests/run-browser.ts`](../../apps/layerglass/tests/run-browser.ts).
GitHub CI also runs the independent hosting workflow: it tests artifact source
identity, tampered/missing/extra files, private output and symlink rejection,
public-byte verification, headers and real 404 routing before publication.

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

The timeline-events JPEG fixture waits for a complete native image owned by the
current session, camera, controller version and frame source before preparing
Pause. It calls the production Pause action only when playback is playing, then
keeps the original paused/image readiness wait and strict pixel, recorded-clock,
Stats, marker and single-seek assertions. Playing and already-paused entry
controls must retain the same image and session; held image bodies and mismatched
owners must fail setup before Pause or marker assertions. Setup failures include
bounded controller/image/video snapshots and close their context and HTTP server
without replacing the original error. All existing wait and suite budgets apply.
These generated browser controls establish the fixture contract; they do not
prove the cause of a historical CI timeout or physical device behavior.

The transport regression includes forward seeks that skip just one recorded
fragment. Those seeks must reposition the paced archive response immediately;
ordinary consecutive playback keeps the existing response. The browser checks
also verify that returning to Live reaches the current edge without recurring
playlist or segment requests.

The default history reconnect suite runs its own generated loopback HTTP/SSE
server. It connects production Stats, PageReplay, PrinterHistory, PlayerUpdates
and the Chromium Cast sender to recorder-shaped fixture payloads. It checks
partial-history hydration after an SSE-only reconnect, without local seek events,
plus future-point suppression, pending-read coalescing, cached readings and an
explicit local-seek control. WebKit uses only an external-clock adapter and must
remain Cast-ineligible. This fixture needs no printer, receiver or media decoder;
the existing video/history suites cover actual video playback separately.

## Focused commands

For an individual Python file, use a built runtime image and mount the checkout
read-only (substitute the daemon-visible path if different):

```sh
docker build -t local/layerglass-test .
docker run --rm --init --name codex__layerglass_python_focus \
  -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/app/apps/python-backend \
  -v "$PWD:/app:ro" -w /app/apps/python-backend \
  local/layerglass-test python -B -m unittest discover -s tests -p test_discovery_cache.py -v
docker image rm local/layerglass-test
```

`apps/layerglass/tests/run-js.sh` copies sources into a temporary directory, installs locked npm
dependencies there, compiles the browser staging tree and runs type/lint/format
checks plus `npm test` by default. Append a script such as
`apps/layerglass/tests/browser-esm.ts` for a focused browser run. Use the pinned Playwright image
from `scripts/check.sh`. Point `VIEWER_URL` at the generated fixture, ideally
`http://127.0.0.1:8080` in its shared Docker network namespace for secure-context
storage/service-worker checks. No `node_modules` directory is written to the checkout.

The default CI PWA run verifies network-only development mode. Full offline
update/rollback checks in `browser-pwa.ts` require a separate fixture with
`FIXTURE_PWA=1` and `PWA_CACHE_ENABLED=1`, and `FIXTURE_PWA=1` in the browser
container. Do not enable caching in the normal dev stack just to run those checks.

## Hardware and opt-in checks

`check_live_discovery.py`, `benchmark_discovery.py`, `browser-discovery-live.ts`
and `browser-scrub-preview-live.ts` are manual integration tools, excluded from
the automatic suite. Set their target/scope explicitly before running them.
Do not point CI at a personal deployment or attach public PR jobs to a LAN runner.

Native iPhone fullscreen/PiP/AirPlay, browser media panels, real Cast receivers,
physical hardware acceleration and actual printer firmware need device checks.
The Cast suite stubs Google's sender SDK while exercising real local media;
it cannot prove receiver playback. Record results in the
[device checklist](../product/roadmap.md).
