---
title: GitHub deployment settings
tags: [operations, github, cloudflare, delivery]
---

# GitHub deployment settings

[Vault home](../index.md) · [Cloudflare hosting](cloudflare.md) · [CI/CD](../development/ci-cd.md)

For `ewized/layerglass`, the
[Deploy public sites workflow](../../.github/workflows/cloudflare.yml) needs
**two secrets and one repository variable**. It publishes `layer.glass` and
`app.layer.glass` to Cloudflare Workers Static Assets.

## 1. Add the two secrets

Open [repository Settings → Environments](https://github.com/ewized/layerglass/settings/environments),
create/select **`cloudflare-production`**, then add these **Environment secrets**:

| Secret name | Value to enter |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A dedicated Cloudflare deployment API token with access to the two Workers below. |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID that owns both Workers and the `layer.glass` zone. Use the account ID, not the zone ID. |

Copy the account ID from your Cloudflare account; the
[official lookup instructions](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)
show where to find it.

The existing [dotenv template](../../infra/cloudflare/.env.example) lists these
same two keys. Its blank values are placeholders. GitHub does not read this
file automatically; enter the names and actual values in GitHub settings.
Keep any filled local copy outside the checkout.

Configure this environment's **Deployment branches and tags** to allow the
`main` branch. Repository-level Actions secrets with the same names are also
supported by the workflow; environment secrets keep the deployment credentials
scoped to the publishing job. GitHub plan availability for private repositories
is described in its
[environment guide](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## 2. Add the enable variable

Open [Settings → Secrets and variables → Actions → Variables](https://github.com/ewized/layerglass/settings/variables/actions)
and add this **repository variable**:

| Variable name | Value |
| --- | --- |
| `CLOUDFLARE_DEPLOY_ENABLED` | `true` |

Use the lowercase value `true`. This is a variable, not a secret, and must be
available at repository scope: the workflow checks it before its validation
jobs run, outside the `cloudflare-production` environment. An absent value or
`false` leaves deployment skipped. Add the credentials before enabling it.

## 3. Give the Cloudflare token deployment access

For the existing installation, use an account-owned token with **Workers Editor**
access to these Workers in the selected account:

| Worker | Custom Domain |
| --- | --- |
| `layerglass-site` | `layer.glass` |
| `layerglass-web` | `app.layer.glass` |

Changing Custom Domains also needs **Zone → Workers Routes → Write** for the
`layer.glass` zone. Updating an existing Worker without changing its domain
connection needs only the Worker Editor role. Creating a missing Worker needs
Workers product-level Admin for initial setup; these two Workers already exist.
Cloudflare documents these
[roles and token scopes](https://developers.cloudflare.com/workers/authorization/workers/).

## 4. Run deployment

The application and deployment workflow must be merged into `main`. Once the
secrets and variable are set, a push to `main` deploys after CI and hosting checks
pass. For an existing commit, open **Actions → Deploy public sites → Run workflow**
and select **`main`**. Manual runs from other branches are skipped as well.

Inspect the **Publish website and demo app** job, including its final HTTPS
verification step. This workflow deploys only the public static apps. Backend
runtime configuration and per-printer access codes stay on your own hardware.

## Container releases

The [Release image workflow](../../.github/workflows/release.yml) uses GitHub's
automatic `GITHUB_TOKEN` with `packages: write` to publish GHCR images. You do
not need to create a PAT, registry-password secret or `GITHUB_TOKEN` secret.
Image publication follows a matching `v*` version tag and does not update your
local Docker container. See [CI/CD](../development/ci-cd.md) for that release flow.
