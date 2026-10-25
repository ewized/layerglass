---
title: Development workflow
tags: [development]
---

# Development workflow

[Vault home](../index.md) · [Testing](testing.md) · [CI/CD](ci-cd.md)

## Prerequisites and fixture

Use Git, Docker Engine and Docker Compose. Python, FFmpeg, Node and browser
dependencies run in containers. The browser code uses native ES modules and
Web Components; there is no bundling step.

```sh
docker compose -f compose.dev.yaml up --build
```

Open `http://localhost:8100`. The standalone stack generates video and changing
telemetry, including a second-nozzle example. It never scans a real printer.
Sources are mounted read-only; reload browser changes, restart the fixture for
Python changes, and rebuild after dependency changes. Stop with Ctrl-C and
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
# Or build once and run the complete suite:
./scripts/check.sh all
```

The check script uses disposable containers and removes the test image it builds.
It writes ignored logs/artifacts to `test-results/`. To reuse an already built
runtime image, set `LAYERGLASS_TEST_IMAGE`; the script will not remove that image.

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
