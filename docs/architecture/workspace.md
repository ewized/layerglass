---
title: Nx workspace
tags: [architecture, development]
---

# Nx workspace

[Vault home](../index.md) · [Architecture](overview.md) · [Workflow](../development/workflow.md)

Layerglass has three applications and a documentation project. Nx is a task
runner and dependency graph; it does not introduce a browser framework, CommonJS,
or a mandatory cloud service. The Python backend can still serve the whole local
viewer in one container. No shared library is invented just to fill a directory.

| Project | Source | Targets | Output |
| --- | --- | --- | --- |
| `backend` | [`apps/backend/`](../../apps/backend/) | `build`, `test`, `serve`, `fixture` | `dist/apps/backend` Python sources and providers |
| `web` | [`apps/web/`](../../apps/web/) | `build`, `test`, `browser`, `serve`, `preview` | `dist/apps/web` native static app |
| `site` | [`apps/site/`](../../apps/site/) | `build`, `test`, `preview` | `dist/apps/site` product website |
| `docs` | This vault | `check` | Link/settings/version validation |

The backend depends on web source because it serves those assets and hashes the
shell revision. The standalone web build does not depend on Python. Documentation
validation spans the application files it links to. `nx graph` shows these
dependencies; `nx show project web --json` exposes resolved targets.

## Running targets

`./scripts/check.sh all` remains the container-only entrypoint. `workspace` mode
installs locked dependencies into a disposable container, builds all three
projects twice, demonstrates local Nx cache hits, validates docs and writes the
graph to ignored `test-results/project-graph.json`. Python and fixture browser
checks still run against generated media, never a real printer.
The website check renders both desktop and mobile widths in Chromium and
WebKit and checks the actual built assets and links.

In an environment with the project's Node dependencies and Docker CLI:

```sh
npm ci
npx nx show projects
npx nx run-many -t build --projects=backend,web,site
npx nx test web
npx nx test backend
npx nx run web:browser
npx nx run backend:fixture
npx nx run docs:check
```

`backend:test` and `web:browser` invoke the Docker check script, so no Python or
printer dependency needs installing on the host. The Docker runtime contains
Python and FFmpeg only. For deterministic JavaScript builds and units use the
locked Node/Nx versions, preferably in a disposable development container.

`nx run web:preview` serves the static build at `http://localhost:8101`.
`nx run site:preview` serves the website at `http://localhost:8102`. These are
development servers with `no-store` responses and byte-range support for demo
video. They bind to the container's network interface, so publish only the
intended loopback port when running in Docker.

## Static hosting contract

- `layer.glass` uses `dist/apps/site`.
- `app.layer.glass` uses `dist/apps/web`, after the backend selector is integrated.
- The hosted web build selects the demo provider explicitly through its HTML
  `layerglass-backend` metadata. Python-served source retains its Python default;
  explicit user preferences can select another configured backend.
- Root files are `index.html`, `manifest.webmanifest` and `service-worker.js`.
  Browser modules, icons, demo media and hls.js stay under `/static/`.
- The build computes the service worker's shell revision and substitutes valid
  JavaScript for both worker placeholders. PWA response caching remains off for
  active development. IndexedDB thumbnails are a separate, bounded media buffer.
- A public static host does not proxy private camera feeds. Real-printer
  discovery, credentials, MQTT and server DVR remain local-backend capabilities.

The site links to a hosted sample demo and container installation instructions.
Building these outputs does not create DNS records, publish them or replace the
existing prototype deployment. Cloudflare deployment configuration is separate.

## Cache policy

Only deterministic static/source builds and JavaScript units use local Nx task
caching. Named inputs include project files, shared configuration/lockfiles,
the product version and the Node version; build helpers are declared inputs.
Build artifacts are limited to each project's `dist/apps/<project>` directory.
`.nxignore` also excludes local environment files, Cloudflare development secrets
and runtime/recording directories from graph inputs. Backend unit checks involve
sockets, FFmpeg and clocks, so they are not cached.
Neither browser fixtures, discovery, live servers, previews nor documentation
checks use task caching. Nx Cloud is disabled; `.nx/`, runtime data, recordings,
access codes and diagnostic artifacts are ignored and are never cache outputs.

## Relocation and feature integration

The first workspace commit contains exact Git renames to preserve provenance and
make concurrent feature branches easier to integrate. The runtime import names
and public HTTP URLs are unchanged.

| Previous path | Workspace path |
| --- | --- |
| `app.py`, `cameras.py`, `discovery.py`, `identity.py`, `replay.py` | `apps/backend/<same filename>` |
| `providers/`, `requirements.txt` | `apps/backend/<same path>` |
| `static/` | `apps/web/src/` |
| Python `tests/*.py`, including the fixture | `apps/backend/tests/` |
| JavaScript `tests/*`, including browser helpers | `apps/web/tests/` |
| `scripts/`, `docs/`, `.github/`, Docker and Compose files | Remain at workspace root |

For feature branches based on the flat prototype, merge their behavior changes
before the exact relocation commit and subsequent workspace tooling commit.
Git can move edits to renamed files automatically; move newly added files using
the table, then update filesystem imports in JavaScript tests from `../static/`
to `../src/`. Browser imports such as `/static/player.js` remain unchanged.
The backend's default static directory is `apps/web/src`; deployments may
override it with `LAYERGLASS_STATIC_DIR`. Run the complete fixture checks after
integration, especially the backend selector and timeline browser regressions.

Nx guidance: [existing projects](https://nx.dev/docs/getting-started/start-with-existing-project),
[explicit project targets](https://nx.dev/docs/reference/project-configuration),
and [deterministic caching](https://nx.dev/docs/getting-started/tutorials/caching).
