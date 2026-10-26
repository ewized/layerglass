---
title: Continuous integration and delivery
tags: [development, delivery]
---

# Continuous integration and delivery

[Vault home](../index.md) · [Workflow](workflow.md) · [GitHub settings](../operations/github-deployment.md)

## Main is the production branch

Every successful `main` pipeline deploys the product website and app to Cloudflare
and publishes a Docker image to GHCR. Pull requests and `codex/**` branch pushes
run the same source and hosting checks without production credentials or writes.
The README badge links to the [CI entrypoint](../../.github/workflows/ci.yml).
There is no deployment-enable variable. Missing credentials fail the publishing
job explicitly instead of silently skipping production.

| Workflow | Responsibility |
| --- | --- |
| [CI](../../.github/workflows/ci.yml) | Main/branch/PR entrypoint; waits for both check jobs before production publication |
| [Source checks](../../.github/workflows/checks.yml) | Compose/actionlint, Docker build, Python/JavaScript, Nx and all registered browser suites |
| [Hosting checks](../../.github/workflows/cloudflare-check.yml) | Build both static apps once; test hosting; record a source/file manifest; upload the validated artifact |
| [Website deployment](../../.github/workflows/cloudflare.yml) | Download that artifact by immutable ID; verify hashes; deploy both domains and verify public bytes |
| [Image publication](../../.github/workflows/publish-image.yml) | Shared amd64/arm64 Docker build, GHCR publication and digest/platform verification |
| [Versioned release](../../.github/workflows/release.yml) | Validate a matching version tag, then call the same image publisher in the release channel |

Source and hosting checks run in parallel on GitHub-hosted Ubuntu runners.
Generated Docker fixtures need no printer, private LAN runner or deployment
secrets. Actions use full commit pins; Node, Playwright, Nx and Wrangler run in
containers. Dependabot proposes dependency updates separately.

After both checks pass on `main`, website deployment and image publication run
in parallel. An in-progress main pipeline is not canceled by another merge.
Publication jobs are serialized for their production targets. Branch/PR runs
can cancel superseded checks. Keep topic branches short-lived; merge reviewed
changes and delete their remote branches after integration.

## Build once, promote the validated files

The hosting job prepares `dist/apps/site` and `dist/apps/web`, including security
and freshness headers. [The delivery helper](../../scripts/delivery.mjs) writes a
manifest outside the public directories containing the full Git SHA and every
asset's SHA-256 and size. It rejects unexpected output directories, private
configuration and symlinks. The manifest and both builds form one immutable
GitHub artifact; diagnostics and public assets are separate artifacts.

Production downloads the exact artifact ID from the successful hosting job.
It checks the source SHA and complete file set before publishing. It installs
only the locked deployment toolchain and does not rebuild the applications.
The Cloudflare helper verifies routing/headers; the delivery helper also checks
that public HTML, bootstrap and service-worker bytes match the validated files.
The deployment summary records the source revision and both production URLs.
Artifacts expire after seven days; rerun the pipeline if an old artifact expired.

## Docker channels

| Trigger | Published tags |
| --- | --- |
| Successful main pipeline | `latest`, `sha-FULL_COMMIT_SHA` |
| Matching version tag, for example `v0.1.0` | `0.1.0`, `release-sha-FULL_COMMIT_SHA`, plus `stable` for a non-prerelease |

Images live at `ghcr.io/ewized/layerglass` and contain Linux amd64 and arm64
platforms, provenance/SBOM attestations, and OCI source/version/revision labels.
The job verifies both architectures and records the exact image digest for
rollback. Use a digest when an installation needs an immutable image reference.
Versioned releases cannot overwrite the rolling main `latest` channel.

GitHub's automatic `GITHUB_TOKEN` gets `packages: write` only in publishing jobs;
no PAT or registry-password secret is needed. On first publication, inspect the
GHCR package's visibility and repository access settings for the intended users.
Publishing an image does not recreate an operator's existing installation.

For a versioned release, update `VERSION`, package metadata, the Dockerfile
build-argument default and Compose default version together. Merge and validate,
then create an annotated matching `v*` tag. The tag pipeline revalidates that
exact source and refuses a tag/version mismatch. Treat version tags as immutable.

## Deployment recovery and rollback

Both [Cloudflare secrets](../operations/github-deployment.md) belong in the
`cloudflare-production` environment, restricted to `main`. For continuous
deployment, that environment must not require a manual approval on each run.
The only production domains are `layer.glass` and `app.layer.glass`; no Python
backend, printer credentials or private camera feeds enter public hosting.

If one publication job fails, the other may have succeeded. Inspect both job
summaries. Fix credentials or permissions, then rerun failed jobs to reuse the
successful checks and artifact. Actions → CI → Run workflow on `main` performs
a fresh complete validation and publication when that is preferable.

Revert a faulty source change through Git and merge the revert into `main` to
ship the prior behavior through the same checks. For urgent website rollback,
select the prior version of each exact Worker as described in
[Cloudflare operations](../operations/cloudflare.md). Follow with the source
revert so the next automatic deployment preserves that rollback.

For Docker installations, select the recorded prior image tag/digest, back up
`/data`, pull and recreate the service. The installation operator chooses this
update; account for future data migrations in release notes. Never put access
codes, stream URLs or tokens in image labels, build arguments or artifacts.
