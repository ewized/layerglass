---
name: layerglass-player
description: Change Layerglass playback, native ES-module Web Components, live-relative scrubbing, local previews, PiP or casting while preserving its mobile camera experience.
---

# Layerglass player

Read the relevant portion of [architecture](../../../docs/architecture/overview.md).
Use [Web Component interfaces](../../../docs/web-components.md) for UI work and
[video delivery](../../../docs/video-delivery.md) for transport work.

- Keep one native video element/decoder. Thumbnails sample decoded frames;
  diffusion samples bounded colors and animates CSS. Neither opens another stream.
- Treat scrubbing as a preview gesture, then one committed seek. Preserve the
  live-relative offset at equal capture/playback rates; see
  [timeline equations](../../../docs/live-timeline.md).
- Local thumbnail RAM and IndexedDB have separate bounds and session ownership.
  Missing images can use server sprites. Still images do not replace the server
  DVR for replay video. Read [preview storage](../../../docs/local-previews.md)
  before changing retention, timestamps or capture scheduling.
- Recorded telemetry follows the video clock. Do not show current printer data
  as if it belongs to a historical frame; see
  [telemetry history](../../../docs/printer-telemetry.md).
- Settings contain printer setup; the context menu contains Mini player,
  Stats for nerds and Copy debug info. Retain accessible names on icon-only actions.
- Native video PiP keeps header, timeline and diagnostics on the main page.
  Custom fullscreen is preferred, with native video fallback where necessary.
  Platform UI is not under application control.
- Keep `printer-*` custom-element tags and existing storage/cache namespaces
  stable through branding changes. Preserve cleanup of listeners, timers, blobs
  and sessions on disconnect.

Use the relevant unit and fixture browser suites listed in
[testing](../../../docs/development/testing.md). For Playwright module state,
use `apps/web/tests/player-page.js` and synchronous readiness predicates; an async
`waitForFunction` predicate can accidentally succeed on the Promise itself.
Physical PiP, AirPlay and hardware-decoder behavior need device verification;
fixture coverage should be reported separately.
