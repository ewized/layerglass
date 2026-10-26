---
title: GitHub deployment settings
tags: [operations, github, cloudflare, delivery]
---

# GitHub deployment settings

[Vault home](../index.md) · [Cloudflare hosting](cloudflare.md) · [CI/CD](../development/ci-cd.md)

The [CI workflow](../../.github/workflows/ci.yml) automatically deploys
`layer.glass` and `app.layer.glass` and publishes the production Docker image
after a main-branch commit passes both source and hosting checks. No enable
variable or manual deployment action is required.

## Cloudflare secrets

Open [repository Settings → Environments](https://github.com/ewized/layerglass/settings/environments),
create/select **`cloudflare-production`**, and add these **Environment secrets**:

| Secret name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A Cloudflare deployment API token allowed to update the two Workers below |
| `CLOUDFLARE_ACCOUNT_ID` | The account ID owning both Workers and the `layer.glass` zone; not a zone ID |

The [dotenv template](../../infra/cloudflare/.env.example) lists the same keys.
GitHub does not read that file automatically. Enter actual values in the GitHub
settings; keep filled local files outside the checkout. Find the account ID with
[Cloudflare's account lookup guide](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).

Restrict the environment's **Deployment branches and tags** to `main`. Leave
per-deployment reviewer approvals off when unattended continuous deployment is
wanted. Repository-level secrets with the same names are supported too;
environment secrets take precedence in the publishing job. GitHub documents
[environment availability and protections](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

The old `CLOUDFLARE_DEPLOY_ENABLED` repository variable is no longer read and can
be removed. Missing secrets now fail the deployment job with the two required
names, while branch and PR checks remain credential-free.

## Cloudflare token permissions

Prefer a dedicated deployment token for the selected account and these Workers:

| Worker | Custom Domain |
| --- | --- |
| `layerglass-site` | `layer.glass` |
| `layerglass-web` | `app.layer.glass` |

Use Workers Editor access to update existing Workers. Changing their Custom
Domains also needs **Zone → Workers Routes → Write** for `layer.glass`.
Creating a missing Worker requires product-level permission for initial setup.
See [Cloudflare token roles](https://developers.cloudflare.com/workers/authorization/workers/).
No zone-wide routing changes or unrelated Workers belong in this deployment.

## Docker publication

Image jobs use GitHub's automatic `GITHUB_TOKEN` with `packages: write`. Do not
add a PAT, registry-password secret or `GITHUB_TOKEN` secret. A successful main
pipeline publishes `ghcr.io/ewized/layerglass:latest` and a `sha-*` tag; matching
version tags publish versioned images and the separate `stable` channel.
See the [channel and rollback table](../development/ci-cd.md).

The publisher verifies amd64/arm64 manifests and prints the exact image digest
in its job summary. Inspect GHCR package visibility and Actions access on first
publication. An existing local Docker container is updated by its operator.

## First run and recovery

Merge the workflow into `main` after configuring the secrets. The resulting CI
run validates once, promotes the validated website/app artifact, and publishes
the Docker image. Review both publication jobs and their summaries.

For an existing main commit, use **Actions → CI → Run workflow → main**.
After correcting a credential or permission failure, **Re-run failed jobs**
reuses successful validation and its artifact; a full rerun rebuilds them.
Expired artifacts need a full rerun. Publication from other branches and pull
requests is disabled.
