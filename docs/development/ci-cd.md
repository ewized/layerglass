---
title: CI and container releases
tags: [development, delivery]
---

# CI and container releases

[Vault home](../index.md) · [Workflow](workflow.md)

## Continuous integration

[`ci.yml`](../../.github/workflows/ci.yml) runs on pushes to `main` and `codex/**`
topic branches, and on pull requests. It is reusable by the release workflow.
Topic branches can be validated before a pull request exists. It validates both Compose
files and workflow syntax, builds the runtime container, then runs Python,
JavaScript and representative Chromium/WebKit checks. The README badge points
to this workflow. Artifacts expire after seven days.

Checks use GitHub-hosted Ubuntu runners with read-only repository permissions.
The camera/telemetry fixture is generated locally in disposable containers;
there are no printer credentials, LAN runners or deployment secrets. External
actions are pinned by commit SHA. Dependabot proposes weekly action, npm and
Python dependency updates. Review vendored hls.js separately using its recorded
version/hashes and license notices.

## Versioned image publication

[`release.yml`](../../.github/workflows/release.yml) responds to `v*` tags. Before
publishing it reruns the reusable CI workflow for that exact tagged source and
checks that the tag matches `VERSION`. Package versions must agree as well.

1. Update `VERSION`, both package metadata files, the Dockerfile build-argument
   default and Compose's default image version together.
2. Review and merge the release change; check CI.
3. Create an annotated matching version tag, for example `v0.1.0`, and push it.
4. Inspect the Release image run and the resulting GHCR package before deployment.

The release job uses the repository's automatic `GITHUB_TOKEN` with
`packages: write`; no personal access token is required. It builds Linux amd64
and arm64 images, with provenance/SBOM attestations and OCI source/version/revision
labels. Tags include the exact version and commit SHA. Stable releases also
update `latest`; prereleases do not. Treat published version tags as immutable.

The initial source import does not push a release tag or claim an existing image.
On first publication, verify the GHCR package visibility/settings permit the
intended users to pull it. Repository Actions/package policies may need to allow
publication. A workflow file alone cannot guarantee those account-level settings.

## Deployment and rollback

Image publication does not deploy to a NAS or replace an existing container.
An operator selects a tested version in `LAYERGLASS_VERSION`, backs up `/data`,
then runs `docker compose pull` and `docker compose up -d --no-build`.
Roll back by selecting the prior tested image version and recreating the service,
accounting for any future data migrations in that release's notes.

Never put access codes or live stream URLs in workflow variables, build args or
image labels. Current Compose deployments use their own `.env` and local volumes.

## Public website and demo

Cloudflare hosts the separate static product website and demo app. Its
[deployment guide](../operations/cloudflare.md) covers exact domain scopes,
containerized build/check/dry-run commands, a gated GitHub workflow and rollback.
Public hosting never deploys a Python backend or receives private camera feeds.
