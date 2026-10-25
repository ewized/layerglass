---
title: Import the prototype as core parts
tags: [decision, history]
status: accepted
date: 2026-10-25
---

# Import the prototype as core parts

[Vault home](../index.md) · [Architecture](../architecture/overview.md)

## Context

The working camera prototype was developed before this repository existed.
Its imported baseline is prototype version **3.4.18**. The original source
directory had no Git history. The product is now named **Layerglass** and its
repository is `ewized/layerglass`.

## Decision

Import the baseline using focused Conventional Commits for repository setup,
printer adapters/discovery, streaming/DVR, browser player, tests, documentation
and delivery tooling. These are logical import commits with actual import
timestamps. They do not reconstruct or claim the dates or intermediate behavior
of the original development sessions.

Use **0.1.0** as the initial Layerglass version. The repository is prepared for
tagged releases; importing it does not create a release or deploy to the existing host.
Keep the established runtime module boundaries and behavior. Product naming,
portable Compose configuration, documentation and reproducible checks are the
intentional migration changes.

Keep existing browser database, cache and preference keys to avoid an incidental
storage migration. Move technical documentation into an Obsidian-compatible
`docs/` vault using relative Markdown links. `AGENTS.md` routes agents to focused
project skills and canonical documentation.

## Consequences

Reviewers can navigate the core parts and run checks without a physical printer.
The source history is honest about its origin. Existing prototype installations
are not renamed or replaced by this import. Credentials, runtime recordings and
local test artifacts are excluded from the public repository.
