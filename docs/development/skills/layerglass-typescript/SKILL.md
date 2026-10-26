---
name: layerglass-typescript
description: Write, migrate or review LayerGlass TypeScript, Lit custom elements, Emotion styling, typed backend contracts and edge/browser rendering boundaries.
---

# LayerGlass TypeScript

Read [coding conventions](../../coding-conventions.md), the
canonical guide in the Obsidian vault. Follow its linked compiler/lint/format settings
rather than duplicating their rules here.

For playback and native media changes, also use the [player skill](../../../../.agents/skills/layerglass-player/SKILL.md).
For builds, Docker and publishing, use the [delivery skill](../../../../.agents/skills/layerglass-delivery/SKILL.md).
The [rendering decision](../../../decisions/0002-typescript-lit-and-edge.md)
explains the framework choice and the browser service worker versus edge Worker split.
Run the applicable [checks](../../testing.md) and update the
owning vault note when changing a contract or architectural boundary.
