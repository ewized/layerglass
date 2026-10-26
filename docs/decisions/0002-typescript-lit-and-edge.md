---
title: TypeScript, Lit, Emotion and edge rendering
tags: [decision, architecture]
---

# 0002 — TypeScript, Lit, Emotion and edge rendering

Status: accepted.

## Context

The prototype uses native media, native ES modules and light-DOM custom elements.
The product needs explicit transport contracts, reusable component lifecycle tooling,
consistent styles and useful rendering on its Cloudflare deployment. The user's
framework preference was Solid if it directly used Web Components, otherwise Lit.

## Decision

Use strict TypeScript for owned JavaScript sources and tools. Use Lit for the
custom-element lifecycle, preserving light DOM and native media identity. Solid's
components are functions returning JSX; its separate
[solid-element adapter](https://github.com/solidjs/solid/tree/main/packages/solid-element)
adds custom elements. Lit directly meets the requested component model.

Use framework-independent Emotion with an extracted global stylesheet and one cache
per document. Keep the browser's native ESM URLs. Bundle third-party UI dependencies
locally in one platform module, with the bundled packages’ license notices; no runtime CDN is needed. Backend contracts are a
shared Nx library, separate from the three provider implementations.

Use a Cloudflare Worker to render the public backend-choice shell on navigation,
then attach the Lit component's behavior to that trusted markup. Keep the Python
installation's explicit backend default and the hosted application's explicit choice.
The browser service worker remains responsible for its own offline/update lifecycle;
it never becomes a server. Development PWA shell caching remains off.

This is public shell SSR and light-DOM adoption. It does not claim Lit Labs shadow-DOM
hydration: [Lit SSR is experimental and currently supports shadow-DOM components](https://lit.dev/docs/ssr/overview/).
No printer state or network discovery is rendered or proxied by the edge.

## Consequences

A Node build stage is required; the Python runtime still needs no Node toolchain.
Source `.ts` files are not served as JavaScript. Compiler checks, component lifecycle
fixtures, emitted-module checks and local edge tests must run before publication.
Behavior and resource limits remain documented in their existing vault notes.
The [coding guide](../development/coding-conventions.md) owns the detailed conventions;
[workspace](../architecture/workspace.md) and [hosting](../operations/cloudflare.md)
own commands and operational configuration.
