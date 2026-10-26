---
title: TypeScript and browser conventions
tags: [development, typescript, conventions]
---

# TypeScript and browser conventions

This note is the canonical coding guide. The [agent skill](../../.agents/skills/layerglass-typescript/SKILL.md)
routes here; it does not keep a second copy. Compiler, formatter and lint settings
in the repository are executable policy. See [testing](testing.md) for commands,
[workflow](workflow.md) for commits and [workspace](../architecture/workspace.md)
for module ownership.

## Types and boundaries

Write application browser and Node tooling modules in TypeScript, with native ESM imports.
Legacy browser/VM regression fixtures remain executable JavaScript against the emitted
modules; they are behavioral tests, not unchecked TypeScript renamed for appearances.
New typed transport and rendering tests use TypeScript.
Browser imports name the emitted `.js` file; Node-only tools use explicit `.ts`
imports and Node's type stripping. Use type-only imports for erased dependencies.
Keep strict checking and checked array indexing enabled. Prefer inferred local
types, explicit public contracts and small interfaces for platform adapters.

Parse external JSON as `unknown`, then check its shape at the transport boundary.
Retain protocol field names, including Python's snake_case; format them for display
at the UI boundary. Represent backend choices and protocol variants with discriminated
unions. Avoid `any`, unchecked double assertions, suppression comments and non-null
assertions without a local invariant. Narrow caught errors before inspecting them.
The [shared backend contracts](../../apps/backend-contracts/src/index.ts) belong to
all providers; manufacturer-specific fields remain in their provider.

Use descriptive names: PascalCase for types/components, camelCase for values and
functions, and existing protocol/storage names unchanged. Prefer `const`, short
functions, early returns and explicit cleanup. Comment constraints and reasons;
avoid narrating the syntax. Do not add speculative abstractions or printer controls
to a camera change.

## UI and styles

Use Lit custom elements with light DOM. Static templates may use the trusted
repository template boundary; printer names, responses and URLs must never become
unescaped HTML. Preserve one native video element across component reconnects,
rendering, fullscreen and PiP. Abort owned listeners and release timers, object URLs,
streams and sessions on teardown. See [component contracts](../web-components.md)
and the [player skill](../../.agents/skills/layerglass-player/SKILL.md).

Emotion owns the application theme. Its extracted stylesheet provides first paint,
and a document-scoped cache reuses the same rule IDs when components connect.
Reuse that cache instead of creating a new cache per control. Frequently changing
colors and timeline positions use CSS custom properties rather than creating a new
class per frame. Keep semantic HTML, keyboard focus, accessible names and reduced
motion behavior intact. The marketing site may retain its independent static CSS.

## Rendering and privacy

Cloudflare Workers render the public initial app shell at the edge. Browser service
workers handle browser navigation/offline policy; they are not servers and cannot
perform edge SSR. Keep those entrypoints and runtime type environments separate.
Never put printer addresses, access codes, telemetry or video into public SSR output,
a public cache or a cloud proxy. Existing development shell caching stays disabled.
See the [rendering decision](../decisions/0002-typescript-lit-and-edge.md).

## Verification

Format changed code with Prettier, run strict TypeScript and lint checks, then run
focused unit/browser fixtures. Changes spanning transports, components and delivery
require the full [fixture workflow](testing.md). Test externally visible behavior,
resource bounds and lifecycle identity, not copies of implementation details.
Report actual browser fixtures separately from hardware checks.

## Sources and choices

These conventions adapt primary sources to this repository; they do not import
another organization's internal rules wholesale.

- [TypeScript strict checking](https://www.typescriptlang.org/tsconfig/strict.html)
  and [checked indexing](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html)
  explain the compiler guardrails.
- [Google's TypeScript guide](https://google.github.io/styleguide/tsguide.html)
  informs naming, type inference and boundary discipline.
- [typescript-eslint configurations](https://typescript-eslint.io/users/configs/)
  describe typed lint presets and their tradeoffs.
- [Lit light DOM](https://lit.dev/docs/components/shadow-dom/#implementing-createrenderroot)
  supports retaining the current DOM and media lifecycle.
- [Emotion instances](https://emotion.sh/docs/@emotion/css) and
  [cache options](https://emotion.sh/docs/@emotion/cache) document framework-independent
  styling, extracted rule hydration and document containers.
- [Cloudflare asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
  and [HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/)
  describe request-time shell rendering. [MDN's service worker reference](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
  describes the distinct browser lifecycle.
