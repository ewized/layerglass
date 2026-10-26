---
title: Nx workspace
tags: [architecture, development]
---

# Nx workspace

[Vault home](../index.md) · [Architecture](overview.md) · [Workflow](../development/workflow.md)

LayerGlass has five product/backend projects and a shared `backend-contracts` library under `apps/`. Nx manages their independent
builds, tests and dependencies; the browser projects use native ES modules.
The two browser backends are embeddable modules and need no running server.

| Project | Source | Purpose | Output |
| --- | --- | --- | --- |
| `backend-contracts` | [`apps/backend-contracts/`](../../apps/backend-contracts/) | Typed public transport contracts and boundary helpers | `dist/backends/backend-contracts` |
| `python-backend` | [`apps/python-backend/`](../../apps/python-backend/) | Optional Python service: discovery, saved printers, telemetry and DVR | `dist/apps/python-backend` source package |
| `demo-backend` | [`apps/demo-backend/`](../../apps/demo-backend/) | Simulated printer data, preloaded replay and bundled demonstration video | `dist/backends/demo-backend` |
| `local-backend` | [`apps/local-backend/`](../../apps/local-backend/) | Approved direct-printer connections, MJPEG transport and local-file sessions | `dist/backends/local-backend` |
| `layerglass` | [`apps/layerglass/`](../../apps/layerglass/) | Camera player, backend selection and Web Components | `dist/apps/layerglass` public static app |
| `layerglass-site` | [`apps/layerglass-site/`](../../apps/layerglass-site/) | Marketing website, product vision and installation links | `dist/apps/layerglass-site` public website |
| `docs` | This vault | Link/settings/version validation | No build output |
| `cloudflare` | [`infra/cloudflare/`](../../infra/cloudflare/) | Hosting checks and delivery of the two public builds | Hosting configuration |

## Dependencies and ownership

`local-backend` owns direct-printer identity checks, multipart camera framing and
the common local-file/session transport. It does not import player or demo code.
`demo-backend` extends that file transport with its own simulation and sample
video. Its simulated readings never enter a local file or real direct connection.
Each module has its own `build` and `test` targets and unit tests.

`layerglass` depends on both browser modules. Its compatibility entrypoints under
`src/backend/` keep player imports stable, while implementations live in the
backend projects. The Python HTTP client stays with the player; the actual Python
service lives in `python-backend`. That service depends on the player source
because its Docker build can serve the complete compiled viewer in one container.

[`browser-modules.json`](../../apps/layerglass/browser-modules.json) explicitly
lists the public browser modules. Static builds compose their cached artifacts
into the player output. The Python viewer serves compiled modules from
bounded asset roots under `/opt/layerglass-browser/apps`. TypeScript compiles to
the established native ESM URLs. Lit and Emotion are bundled locally in one platform
module, with an extracted stylesheet and shared cache; see the
[coding guide](../development/coding-conventions.md). Only module `src/` files are public;
Python sources, workspace configuration and tests are outside those roots.
The service-worker revision includes the modules and its shell allowlist lists
their executable files. Shell response caching remains disabled for development.

## Targets and checks

```sh
npm ci
npx nx show projects
npm run typecheck
npm run lint
npm run format:check
npm run build
npx nx test layerglass
npx nx test demo-backend
npx nx test local-backend
npx nx test python-backend
npx nx run layerglass:browser
npx nx run python-backend:fixture
npx nx run docs:check
```

Use the [Docker workflow](../development/workflow.md) for project runtimes.
`npm test` runs the player and both browser-backend test targets.
`python-backend:test` and `layerglass:browser` delegate to disposable Docker checks.
`./scripts/check.sh all` runs Python/TypeScript tests, all fixture browser suites,
documentation and workspace packaging. Its `workspace` mode builds all six
projects twice to verify cache restoration and exports the project graph.
`layerglass-site:test` builds the player and website first, then renders desktop
and mobile layouts in Chromium/WebKit, checks the generated service worker, and
loads the composed static player/demo without Python requests.

`nx run layerglass:preview` serves the built player at `http://localhost:8101`.
`nx run layerglass-site:preview` serves the website at `http://localhost:8102`.
These development servers use fresh responses and support demo-video byte ranges.
When running in Docker, publish only the intended loopback port.

## Public hosting and cache policy

`layer.glass` serves `dist/apps/layerglass-site`; `app.layer.glass` serves
`dist/apps/layerglass`. The hosted player always requires a backend choice on a
first visit. Cloudflare renders that public chooser before browser JavaScript attaches
its behavior. Its browser backends are composed static assets, not public Python
services. Discovery, printer codes, real telemetry and DVR stay on the selected
Python service. See [backend providers](backend-providers.md) and
[public hosting](../operations/cloudflare.md).

Browser-module outputs use `dist/backends/` so the credential-free hosting build
contains the two public application directories and the private `.edge/layerglass.mjs`
renderer under `dist/apps/`. The renderer is outside both public asset roots and its
bytes are included in the validated delivery manifest. Delivery checks
continue to reject unexpected public directories, private files and symlinks.
Cloudflare Worker identities and public domains are deployment identifiers and
remain stable even though their Nx projects and build paths have been renamed.

Only deterministic source/static builds and TypeScript units are cached. Their
inputs include provider dependencies, build helpers, version metadata and the
locked Node toolchain. Browser fixtures, discovery, servers and Python socket/
FFmpeg tests are uncached. Nx Cloud is disabled. `.nx/`, generated outputs,
recordings, access codes and diagnostic artifacts stay out of commits.

## Source migration

The previous `apps/backend`, `apps/web` and `apps/site` roots are now
`apps/python-backend`, `apps/layerglass` and `apps/layerglass-site` respectively.
Demo and direct-printer implementations moved out of the player into their own
projects. Existing player module URLs, backend preference IDs, printer identity
and access-code storage retain their established contracts.
