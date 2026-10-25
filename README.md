# LayerGlass

[![CI](https://github.com/ewized/layerglass/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ewized/layerglass/actions/workflows/ci.yml)

**A clear view of your print, on your own hardware.**

LayerGlass is a self-hosted, mobile-first camera app for 3D printers. Watch live,
rewind the footage collected since you opened the page, and see printer telemetry
at the recorded video time. The core viewer works on your LAN without a cloud
account, including Bambu Lab printers in LAN-only mode.

Our goal is a dependable camera companion: quick to open, easy to scrub, and
useful during a print. New manufacturers fit into approved printer adapters;
Bambu Lab is the first supported manufacturer. See the [product vision](docs/product/vision.md)
and [roadmap](docs/product/roadmap.md).

[Try the browser demo](https://app.layer.glass/?backend=demo) or visit
[layer.glass](https://layer.glass). The demo uses generated footage and simulated
printer readings. Browser mode also opens local video files; connecting a real
Bambu printer still needs the Python backend for its LAN protocols and DVR.
Choose the provider in **Settings → Connection**.

## Run it

Requires Docker Engine and Docker Compose. Build from source for this initial import:

```sh
git clone https://github.com/ewized/layerglass.git
cd layerglass
cp .env.example .env
# Edit DISCOVERY_CIDRS in .env to match your printer's LAN subnet.
docker compose up -d --build
```

Open `http://YOUR_SERVER_IP:8099`. In **Settings → Printers**, select a discovered
printer and enter its LAN access code. Each printer's code is saved on your
server. A responding generic camera is not admitted as a printer.

Use a trusted LAN or an authenticated reverse proxy: the prototype does not yet
have user accounts. HTTPS enables phone installation and browser capabilities
that require a secure context. PWA shell caching stays off by default during
development. [Installation and configuration](docs/operations/installation.md).

## Build with us

```sh
# Generated camera and telemetry; no printer required. Open http://localhost:8100.
docker compose -f compose.dev.yaml up --build

# Python, JavaScript and Chromium/WebKit checks in disposable containers.
./scripts/check.sh all

# Build and verify the Nx projects and dependency graph in a disposable container.
./scripts/check.sh workspace
```

- [Documentation home](docs/index.md) — open `docs/` as an Obsidian vault, or read it on GitHub.
- [Development workflow](docs/development/workflow.md) · [Testing](docs/development/testing.md) · [CI/CD](docs/development/ci-cd.md)
- [Architecture](docs/architecture/overview.md) · [Approved printer adapters](docs/camera-adapters.md)
- [Nx workspace and targets](docs/architecture/workspace.md) — Python backend, native web app and product website.
- [Backend providers](docs/architecture/backend-providers.md) · [Timeline events](docs/timeline-events.md) · [Cloudflare hosting](docs/operations/cloudflare.md)
- [GitHub deployment settings](docs/operations/github-deployment.md) — the secrets and repository variable needed to publish the site and app.
- [AGENTS.md](AGENTS.md) — project guidelines and task-specific skill router.

Commits use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
This repository imports the working prototype in logical parts; the
[import record](docs/decisions/0001-prototype-import.md) explains that history.
Passing version tags can publish `ghcr.io/ewized/layerglass` images; deployments
remain an explicit operator action.

Project home: [layer.glass](https://layer.glass). A project license has not yet
been selected. Bundled third-party code retains its [license notices](apps/web/src/vendor/LICENSE).
