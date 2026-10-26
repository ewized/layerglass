---
title: LayerGlass documentation
aliases: [Home]
tags: [index]
---

# LayerGlass documentation

Open this `docs/` directory as an Obsidian vault. All links also work on GitHub;
no community plugins are required. Personal workspace state is ignored by Git.
Start with the [README](../README.md) for a quick introduction.

## Product and operation

- [Vision](product/vision.md) — who this serves and what the product promises.
- [Roadmap and device checklist](product/roadmap.md) — current capabilities and future work.
- [Installation](operations/installation.md) — Docker, discovery, HTTPS and data.
- [Application guide](reference/application-guide.md) — controls and configuration details.
- [PWA behavior](pwa.md) — installation, development mode and optional shell caching.

## Development

- [Coding conventions](development/coding-conventions.md) — strict TypeScript, Lit, Emotion and rendering boundaries.
- [Workflow](development/workflow.md) — local fixture, branches and commits.
- [Testing](development/testing.md) — reproducible checks without a printer.
- [Twelve-hour review](reviews/2026-10-26.md) — reviewer roster, majority decisions and validated improvements.
- [CI/CD](development/ci-cd.md) — validation, versioning and image publication.
- [Public Cloudflare hosting](operations/cloudflare.md) — product site, demo, domains and delivery.
- [GitHub deployment settings](operations/github-deployment.md) — required secrets, enable variable and token scope.
- [Architecture](architecture/overview.md) — source boundaries and data flow.
- [Nx workspace](architecture/workspace.md) — applications, targets, caching and relocation map.
- [Backend providers](architecture/backend-providers.md) — optional Python service, browser demo and trusted connections.
- [Direct printer backend](architecture/direct-printer.md) — live-only approved Klipper/Moonraker webcams without a LayerGlass container.
- [Agent router](../AGENTS.md) — scoped guidance for agents.
- [Prototype import decision](decisions/0001-prototype-import.md) — provenance and history.

## Technical notes

| Area | Notes |
| --- | --- |
| Printers | [Approved adapters](camera-adapters.md), [telemetry and video time](printer-telemetry.md) |
| Bambu adapter | [MQTT and identity](reference/bambu-telemetry.md), [certificate bundle](reference/bambu-certificates.md) |
| Video | [Continuous delivery](video-delivery.md), [live timeline](live-timeline.md), [print events](timeline-events.md), [casting](casting.md), [browser-direct RTSPS research](reference/browser-rtsp.md) |
| Browser UI | [Web Components](web-components.md), [color diffusion math](video-diffusion.md) |
| Diagnostics and previews | [Debug clipboard](debug-info.md), [local preview storage](local-previews.md) |
