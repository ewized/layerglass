---
title: Public Cloudflare hosting
tags: [operations, cloudflare, delivery]
---

# Public Cloudflare hosting

[Vault home](../index.md) · [CI/CD](../development/ci-cd.md) · [Local installation](installation.md)

Cloudflare serves two public static builds. It is optional for the self-hosted
viewer and has no printer access codes, camera proxy, recordings or telemetry
storage. The Python backend and its local viewer continue to work on the user's
own hardware without a Cloudflare account.

| Worker | Custom Domain | Nx build output | Purpose |
| --- | --- | --- | --- |
| `layerglass-site` | `layer.glass` | `dist/apps/site/` | Product website and install/source links |
| `layerglass-web` | `app.layer.glass` | `dist/apps/web/` | Browser demo and optional connection to the user's backend |

The hosted app must ship without an automatic backend. First visits show Demo,
Docker and Direct printer choices; valid saved selections open directly. Demo uses
bundled sample video and simulated printer data. Docker connects to an explicitly
selected HTTPS Python backend. Settings → Connection can change that choice.
Direct mode supports an identified Klipper/Moonraker MJPEG camera in a compatible
browser, with live viewing only. Its browser and controller requirements are in
[backend providers](../architecture/backend-providers.md). Safari/iPhone and
Bambu LAN cameras use the Docker backend.
A browser cannot directly discover Bambu ports, decode RTSPS, or open its
MQTT TCP connection. Those are Python backend capabilities.

## Hosting boundaries and freshness

Each [Wrangler configuration](../../infra/cloudflare/web.wrangler.json) contains
exactly one custom domain. The equivalent
[website configuration](../../infra/cloudflare/site.wrangler.json) is separate.
There is no Worker application code, API route, service binding, R2 bucket, KV
namespace, analytics binding or access to a printer network. Unknown paths,
including `/api/backend`, return 404; they are never rewritten to the app HTML.
Workers.dev and version preview URLs are disabled. No zone-wide rules, unrelated
Workers or existing deployment hosts are changed by these configurations.

The local Wrangler asset engine can return the whole small demo MP4 for a byte
range request. Its test verifies the delivered bytes and MIME without claiming
that it exercised Cloudflare's outer CDN range handling. Validate that separately
on the deployed host and check native playback/seeking in Chromium and WebKit.

Workers Static Assets distributes the public files through Cloudflare's edge.
The app's browser responses use `Cache-Control: no-store`, and its generated
service worker has shell caching disabled for active development. The product
site uses `max-age=0, must-revalidate` and ETags. Browser IndexedDB thumbnail
buffers are separate temporary media storage and retain their existing policy.

[`prepare`](../../scripts/cloudflare.mjs) places the appropriate `_headers` file
in each build output. The templates add CSP, framing protection, HTTPS, MIME and
referrer headers without disabling fullscreen, PiP or remote playback. The
website runs no script. The app permits scripts from its own origin plus the
existing Google Cast sender SDK origins; HTTPS backend fetch/media origins are
allowed because the user selects their own backend. This permission does not
route that backend traffic through Cloudflare. No wildcard backend CORS policy
is installed by public hosting.

## Connecting a real backend

Keep a backend private unless the operator intentionally exposes it. For the
hosted app, configure the Python backend with the exact allowed frontend origin:

```dotenv
VIEWER_ALLOWED_ORIGINS=https://app.layer.glass
```

For an API/video-only container, also set `VIEWER_SERVE_UI=0`. This disables its
HTML, static assets, manifest and service worker; APIs and streams remain active.
Keep the backend's HTTPS route even when the player UI moves to app.layer.glass.
The hosted app connects directly to that backend origin. Removing its TLS route
would also disconnect the hosted app on browsers that block HTTP mixed content.

Use an HTTPS backend address with a certificate the phone/browser trusts.
Browsers normally block an HTTPS page from fetching an HTTP LAN backend as mixed
content; CORS cannot fix that. Browser local-network permission restrictions may
also apply. An operator can instead open the Python container's same-origin
viewer on the LAN. Its self-hosted CSP can allow a chosen remote HTTPS backend
through `VIEWER_BACKEND_ORIGINS`; this is separate from incoming CORS.

Allowing an origin lets that web app use the backend's setup APIs. Use a trusted
frontend and the backend's intended network/authentication boundary. Do not put
printer codes in public hosting configuration. Cloudflare Tunnel and Access can
be considered separately if remote access is wanted; neither is a requirement
of this installation or a substitute for backend authentication.

## Build and validate

Node, Nx and Wrangler run in disposable containers. Use the Docker-daemon-visible
checkout path for `LAYERGLASS_HOST_PATH` when the checkout is already inside a
development container. The tools are pinned in the root and isolated
[Cloudflare package](../../infra/cloudflare/package.json) lockfiles.

```sh
docker run --rm --init --name codex__layerglass_cloudflare_check \
  --user "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npm-cache \
  -e NX_DAEMON=false -e NX_NO_CLOUD=true -e WRANGLER_SEND_METRICS=false \
  -v "${LAYERGLASS_HOST_PATH:-$PWD}:/app" -w /app node:24-bookworm sh -ec '
    npm ci
    npm --prefix infra/cloudflare ci
    npx nx run cloudflare:prepare
    npm --prefix infra/cloudflare test
    npm --prefix infra/cloudflare run test:local
    node scripts/cloudflare.mjs check all
    node scripts/cloudflare.mjs dry-run all
  '
```

The helper refuses an automatic Python/demo public bundle, unexpanded/enabled shell
caching, missing demo assets, a SPA fallback or a changed domain scope. A dry-run
validates Wrangler's upload configuration without publishing or changing DNS.
Build again before preparing headers; a normal Nx build replaces `dist/`.

## Credentials and first deployment

Use a dedicated API token scoped to this account and the two LayerGlass Workers.
Initial Worker creation requires Workers product permission; attaching these
custom domains also requires Workers Routes Write for the `layer.glass` zone.
After creation, reduce the deployment token to the two existing Workers where
Cloudflare's resource permissions support it. Account and zone read permissions
may be needed by Wrangler's account/domain discovery. Do not reuse a broad token
in CI merely because it is already available on a development machine.

Keep only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in a private mode-0600
environment file outside the repository; the
[example](../../infra/cloudflare/.env.example) contains no credentials. Pass it
with Docker `--env-file`; do not source another project's entire `.env`, embed
tokens in shell arguments, or include credentials in build outputs/artifacts.

After reviewing the built website and demo, deploy the prepared outputs:

```sh
docker run --rm --init --name codex__layerglass_cloudflare_deploy \
  --user "$(id -u):$(id -g)" \
  --env-file /secure/layerglass-cloudflare.env \
  -e WRANGLER_SEND_METRICS=false \
  -v "${LAYERGLASS_HOST_PATH:-$PWD}:/app" -w /app \
  node:24-bookworm node scripts/cloudflare.mjs deploy all
```

Wrangler creates/updates only the two named Workers and their custom domains.
Cloudflare provisions the domains' DNS and certificates; do not add manual
placeholder DNS records. Check for an existing hostname owner before first
deployment. The zone must be active and owned by the selected account.

`node scripts/cloudflare.mjs verify all` checks HTTPS, security/freshness headers,
JavaScript MIME, the backend chooser, disabled shell cache and real 404s for unknown
API paths. Run it in the same Node Docker image. Also inspect the app in a browser
and confirm the demo creates no Python `/api` requests. First certificate
issuance/DNS propagation may need time before verification can pass.

## GitHub delivery

The [public hosting checks](../../.github/workflows/cloudflare-check.yml) run on
relevant main pushes and pull requests without credentials. They build both
static apps, exercise hosting-policy tests, run Wrangler dry-runs and verify
headers, JavaScript MIME and unknown-route behavior against its local asset
engine. No private LAN or physical printer is involved.

The [public deployment workflow](../../.github/workflows/cloudflare.yml) is
disabled until repository variable `CLOUDFLARE_DEPLOY_ENABLED=true` is configured.
It skips harmlessly while that variable is absent. Enabling it requires
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets in the
`cloudflare-production` GitHub environment; create that environment and restrict
its deployment branch to `main`. Repository secrets are an alternative if the
environment intentionally inherits them. No secrets are required by public PR
checks. Do not use `pull_request_target` to deploy untrusted branch code.

When enabled, main pushes and manual runs validate source through reusable CI,
build the static apps, test/check/dry-run hosting, then deploy the two domains.
The workflow verifies the resulting HTTPS endpoints. Configure the secrets and
branch restriction before setting the enable variable. Committing the workflow
does not itself configure the GitHub environment, supply secrets, or establish a
Cloudflare GitHub Builds connection.

## Rollback and inventory

Record the Git commit and Worker version IDs printed by each deployment. The two
Workers publish separately; inspect both after a partial failure. Use Cloudflare
Workers → the exact `layerglass-site` or `layerglass-web` → Deployments to select
the previous known-good version. Wrangler's `rollback VERSION_ID --config ...`
is the equivalent immediate deployment change. Reverify both domains. Rebuilding
and redeploying a known-good source commit is another option; local uncommitted
changes should not be part of that rollback.

These targets have no database/data migration and never roll back a printer's
local state. Deleting a custom domain is a separate operation; Cloudflare may
retain its issued certificate. Inspect certificate inventory if deliberately
removing a host. Do not delete unrelated DNS records, Workers or certificates.

## Primary references

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Static asset headers and freshness](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Custom Domains, DNS and certificates](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Workers roles and API-token permissions](https://developers.cloudflare.com/workers/authorization/workers/)
- [GitHub Actions delivery](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Browser mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)
