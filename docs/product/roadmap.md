---
title: Roadmap and device checklist
tags: [product, roadmap]
---

# Roadmap and device checklist

[Vault home](../index.md) · [Vision](vision.md)

## Working prototype imported

- [x] Camera-first responsive player with native video and custom controls.
- [x] Approved printer discovery, per-printer LAN codes and forget action.
- [x] Read-only local MQTT telemetry with snapshots aligned to rewind footage.
- [x] Session DVR, deferred scrub commits and browser-local thumbnail previews.
- [x] Native video PiP, fullscreen fallbacks, Cast and AirPlay integration.
- [x] Installable PWA; shell caching disabled by default during development.
- [x] Containerized tests, GitHub CI and a versioned image release workflow.

## Product workspace

- [x] Selectable Python backend and browser-only demo/local-video provider.
- [x] Observed print events on the recorded video timeline, without extra polling.
- [x] Separate Nx backend, web and product website projects.
- [x] Public site/demo build outputs and scoped Cloudflare hosting workflows.

## Before a broader release

- [ ] Choose a project license and document the supported-device matrix.
- [ ] Verify installation, reopening, rotation, lock/unlock and background recovery
  on a physical iPhone 11 Pro Max and Android phone over trusted HTTPS.
- [ ] Verify iPhone AirPlay and background recovery, plus Cast disconnect/return
  on a physical receiver. Desktop Chrome → TV playback was user-tested on 2026-10-24.
- [ ] Test fresh installation, upgrades and credential persistence on another Docker host.
- [ ] Define owner/viewer access and remote-access expectations.
- [ ] Establish release notes, retained-data expectations and a support/debug-info process.
- [ ] Verify image releases on physical amd64 and arm64 hosts.

## Candidate product work

These are ideas, not promises or existing behavior. Prioritize against the camera experience.

- Whole-print recording, bookmarks and a useful print history, with explicit retention limits.
- Opt-in alerts for meaningful print events and interruptions.
- More approved printer manufacturers with fixture-backed adapters.
- A small set of local actions, such as lighting or pause/resume, if the supported
  printer APIs and permissions make them dependable. Cancel needs deliberate UX.
- Better connection recovery and mobile performance based on real device measurements.

Cloud dependency, slicing and a general-purpose printer-control dashboard do not
serve the present [vision](vision.md).
