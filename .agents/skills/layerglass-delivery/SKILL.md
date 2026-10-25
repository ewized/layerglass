---
name: layerglass-delivery
description: Work on Layerglass Docker development, fixture tests, GitHub Actions, versioning or container image releases.
---

# Layerglass delivery

Read [workflow](../../../docs/development/workflow.md) for local development and
[CI/CD](../../../docs/development/ci-cd.md) for releases.
The [Nx workspace map](../../../docs/architecture/workspace.md) lists project
targets, paths and static-hosting outputs.

- `scripts/check.sh` owns disposable test containers and its temporary build image.
  Preserve shared Docker resources. If Docker runs outside the workspace's mount
  namespace, set `LAYERGLASS_HOST_PATH` to the daemon-visible checkout path.
- `compose.dev.yaml` is a standalone generated-camera stack on localhost:8100.
  It needs no printer credentials or external proxy network. Production Compose
  remains portable and stores persistent printer settings separately from footage.
- The runtime image contains no test toolchain. Node/Playwright dependencies are
  installed in disposable containers from the lockfile, not into the host workspace.
- Python and printer providers live in `apps/backend/`; native browser ESM and
  their tests live in `apps/web/`. The product website is independent in `apps/site/`.
  `/static/*` is a public URL and does not change when source directories move.
- `nx build web` emits `dist/apps/web` with an explicit demo backend default.
  Python-served source keeps its Python default. Never let a public static host
  silently probe a visitor's LAN or proxy private printer feeds.
- Nx remote caching is not configured. Cache static/source builds and deterministic
  JavaScript units only; Python runtime checks, browser checks and serve targets
  are deliberately uncached. Keep generated outputs and `.nx/` out of source control.
- Public PR checks run on GitHub-hosted runners with read-only repository access;
  never attach those checks to a runner with access to someone's printer LAN.
- Pin workflow actions by full commit SHA. Keep dependency updates reviewable.
  Do not put credentials in build args, logs, labels, caches or artifacts.
- Keep `VERSION`, package metadata and Compose's default image version aligned.
  A matching `v` tag reruns CI before publishing amd64/arm64 images to GHCR.
  Image publication does not deploy to an installation.
- PWA shell caching defaults off during development. Keep reloads fresh while
  preserving temporary media buffering and bounded local preview storage.

Validate workflow syntax with actionlint, both Compose files with `config --quiet`,
and run the appropriate `scripts/check.sh` mode. Report physical-host validation
separately from container/browser fixtures. User authorization takes precedence;
this skill does not require a new confirmation for work already in scope.
