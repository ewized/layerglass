---
name: layerglass-delivery
description: Work on LayerGlass Docker development, fixture tests, GitHub Actions, versioning or container image releases.
---

# LayerGlass delivery

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
- Python and printer providers live in `apps/python-backend/`; native browser ESM and
  their tests live in `apps/layerglass/`. The product website is independent in `apps/layerglass-site/`.
  The browser providers live in `apps/demo-backend/` and `apps/local-backend/`,
  with independent build/test targets and explicit player dependencies.
  `/static/*` is a public URL and does not change when source directories move.
- `nx build layerglass` emits `dist/apps/layerglass` with an explicit backend chooser.
  Python-served source keeps its Python default. Never let a public static host
  silently probe a visitor's LAN or proxy private printer feeds.
- Nx remote caching is not configured. Cache static/source builds and deterministic
  JavaScript units only; Python runtime checks, browser checks and serve targets
  are deliberately uncached. Keep generated outputs and `.nx/` out of source control.
- Public PR checks run on GitHub-hosted runners with read-only repository access;
  never attach those checks to a runner with access to someone's printer LAN.
- Pin workflow actions by full commit SHA. Keep dependency updates reviewable.
  Do not put credentials in build args, logs, labels, caches or artifacts.
- CI is the main/branch/PR entrypoint. Its reusable source and hosting checks run
  once; successful main commits automatically publish both public sites and a
  multi-architecture Docker image. Promote the validated static artifact by ID
  and verify its revision/hashes instead of rebuilding it during deployment.
- Main owns the rolling `latest`/`sha-*` image channel. Version tags own the
  version/`release-sha-*`/`stable` channel and must not replace main `latest`.
- Keep `VERSION`, package metadata and Compose's default image version aligned.
  A matching `v` tag reruns CI before publishing amd64/arm64 images to GHCR.
  Image publication does not deploy to an installation.
- PWA shell caching defaults off during development. Keep reloads fresh while
  preserving temporary media buffering and bounded local preview storage.

Validate workflow syntax with actionlint, both Compose files with `config --quiet`,
and run the appropriate `scripts/check.sh` mode. Report physical-host validation
separately from container/browser fixtures. User authorization takes precedence;
this skill does not require a new confirmation for work already in scope.
