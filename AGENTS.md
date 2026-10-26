# Working in LayerGlass

LayerGlass is a self-hosted camera companion for 3D printers. Start with the
[README](README.md), then read only the guidance relevant to the task.
Documentation lives in the Obsidian vault at [`docs/`](docs/index.md).

## Task router

| Task | Read first | Main source |
| --- | --- | --- |
| Player, Web Components, scrubbing, previews, PiP, casting | [Player skill](.agents/skills/layerglass-player/SKILL.md) | `apps/layerglass/src/`, `apps/python-backend/replay.py` |
| Backend selection, browser mode, hosted frontend connections | [Backend providers](docs/architecture/backend-providers.md), [Player skill](.agents/skills/layerglass-player/SKILL.md) | `apps/layerglass/src/backend/`, `apps/demo-backend/`, `apps/local-backend/`, `apps/python-backend/app.py` |
| Discovery, manufacturer support, access codes, printer telemetry | [Printer skill](.agents/skills/layerglass-printers/SKILL.md) | `apps/python-backend/`, `apps/python-backend/providers/` |
| Nx projects, builds, product website | [Workspace map](docs/architecture/workspace.md), [Delivery skill](.agents/skills/layerglass-delivery/SKILL.md) | `apps/*/project.json`, `apps/layerglass-site/`, `nx.json` |
| Docker, tests, workflows, versions, releases | [Delivery skill](.agents/skills/layerglass-delivery/SKILL.md) | `Dockerfile`, `compose*.yaml`, `scripts/`, `.github/` |
| Public website/app hosting or Cloudflare delivery | [Hosting guide](docs/operations/cloudflare.md), [Delivery skill](.agents/skills/layerglass-delivery/SKILL.md) | `infra/cloudflare/`, `scripts/cloudflare.mjs` |
| Product scope or documentation | [Vision](docs/product/vision.md), [vault home](docs/index.md) | `docs/` |

## Project guidelines

- Write the product name as **LayerGlass** in human-facing copy. Keep existing
  technical identifiers, domains and storage namespaces stable.
- Preserve the camera-first mobile experience: header identifies the printer,
  controls stay at the bottom, setup stays in settings, diagnostics in the context menu.
- The local viewer must work without a cloud account. Keep manufacturer-specific
  behavior in providers and admit only identified, approved printer profiles.
- Browser transport providers and server manufacturer adapters have different
  responsibilities. Browser mode cannot use raw printer TCP/MQTT/RTSPS protocols;
  expose its capabilities honestly and keep access codes on the selected server.
- Current printer telemetry is read-only. Printer-control features are roadmap
  work, not an incidental extension of a camera or telemetry change.
- Keep credentials, private deployment configuration, recordings and generated
  test artifacts out of commits. Use fixtures for automated tests; real-device
  checks require the user's intended device scope.
- Prefer native ES modules and Web Components. Preserve the single native video
  decoder and existing browser storage keys unless a task includes a migration.
- Nx manages `python-backend`, `demo-backend`, `local-backend`, `layerglass`
  and `layerglass-site` targets. Keep the player native
  ESM; build static hosting outputs without introducing a framework or runtime CDN.
  Cache only deterministic tasks, never discovery, browser fixtures or runtime state.
- Use Docker for project runtimes and tests. Run focused checks during development
  and `./scripts/check.sh all` for changes spanning the core parts. The
  [testing guide](docs/development/testing.md) distinguishes fixture and hardware tests.
- Use focused [Conventional Commits](docs/development/workflow.md). Explain the
  behavior change and validation; do not invent historical timestamps.
- Update the corresponding vault note when changing architecture or behavior.
  Keep relative Markdown links usable in both GitHub and Obsidian; run
  `scripts/check-docs.py` through the container workflow.
- A user request supplies task scope and authorization. These guidelines do not
  add approval gates for ordinary edits or previously authorized work. Publishing
  an image and deploying it to an existing installation are separate actions.

The prototype import and stable namespaces are recorded in
[decision 0001](docs/decisions/0001-prototype-import.md). No live installation is
implicitly replaced by checking out this repository.
