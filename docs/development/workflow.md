---
title: Development workflow
tags: [development]
---

# Development workflow

[Vault home](../index.md) · [Testing](testing.md) · [CI/CD](ci-cd.md)

## Prerequisites and fixture

Use Git, Docker Engine and Docker Compose. Python, FFmpeg, Node and browser
dependencies run in containers. Strict TypeScript compiles to native ES modules;
Lit supplies the custom-element lifecycle and Emotion supplies cached/extracted CSS.
Nx preserves the public module URLs and bundles only the third-party UI platform.
See [coding conventions](coding-conventions.md) and the [workspace map](../architecture/workspace.md).

```sh
docker compose -f compose.dev.yaml up --build
```

Open `http://localhost:8100`. The standalone stack generates video and changing
telemetry, including a second-nozzle example. It never scans a real printer.
Sources are mounted read-only. Rebuild/recreate the development stack after browser
TypeScript, theme or dependency changes so its compiled assets match the source.
Restart the fixture for Python changes. For standalone UI iteration, run the
[workspace build and preview targets](../architecture/workspace.md). Stop with Ctrl-C and
`docker compose -f compose.dev.yaml down`.

Set `LOCAL_UID`/`LOCAL_GID` if your host requires a different file owner. When
the Docker daemon sees a different filesystem path, set `LAYERGLASS_HOST_PATH`
to the daemon-visible checkout path for both the dev stack and check script.
For example, a checkout inside a development container may map to
`/srv/projects/layerglass` on its Docker host. Use that host path for bind mounts.

## Change and verify

Start from `main`, use a short branch such as `feat/printer-bookmarks` or
`fix/scrub-offset`, and keep each commit about one behavior. Preserve the
[core boundaries](../architecture/overview.md) instead of adding manufacturer
special cases to the browser entrypoint.

```sh
./scripts/check.sh unit
./scripts/check.sh browser
# Static packaging, repeatable Nx cache hits and project graph:
./scripts/check.sh workspace
# Or build once and run the complete suite:
./scripts/check.sh all
```

The check script uses disposable containers. Default runtime builds have no
output tag; the script validates Docker's recorded image ID and runs that exact
image. Cleanup removes owned containers and temporary records, leaving ordinary
build results/cache to Docker and the operator. The script never removes image
IDs or tags. It writes ignored logs/artifacts to `test-results/`. To reuse an
already built runtime image, set `LAYERGLASS_TEST_IMAGE`; the script will not
build over or remove that image.
With the project Node dependencies installed in a development environment,
`npx nx show projects`, `npx nx test layerglass`, and `npx nx build layerglass-site` address the
independent modules. `npx nx test python-backend` and `npx nx run layerglass:browser` delegate
to Docker fixture checks. See the [workspace map](../architecture/workspace.md)
for all targets and static preview commands.

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
`feat(player): add a bookmark action`, `fix(discovery): reset retry delay`,
`docs: explain preview retention`, or `ci: validate release versions`.
Use `!`/a `BREAKING CHANGE` footer for intentional incompatible changes.
Do not rewrite shared history or backdate reconstructed prototype commits.

Describe the trigger, resulting behavior and relevant validation in a PR. GitHub
CI repeats the fixture checks. Physical-device checks are additional evidence;
state clearly when they have not been performed.

## Documentation

Open `docs/` as an Obsidian vault. Use ordinary relative Markdown links and keep
the home note current. Track shared vault settings, not workspace layouts or
personal plugins. `scripts/check-docs.py` validates local links and version
alignment through the unit workflow. Keep reusable agent instructions in
[AGENTS.md](../../AGENTS.md) and its routed skills.
