---
title: Player UI components
tags: [technical]
---

# Player UI components

[Vault home](index.md)

The UI uses native autonomous custom elements, registered by
`static/components/index.js` through the existing ESM entry point. The page has
one `printer-player` host; importing the entry again reuses its module and player.
There are no new runtime dependencies or build steps.

| Element | Responsibility |
| --- | --- |
| `printer-player` | Player composition, toolbar visibility, keyboard shortcuts, settings visibility |
| `printer-camera-view` | Stable native video/JPEG elements, loading presentation, and frame-colored diffusion in unused space |
| `printer-loading` | Spinner, accessible loading state, explicit play/discovery actions |
| `printer-controls` | Timeline and native buttons; settings/cast/fullscreen action events |
| `printer-scrub-preview` | Local thumbnail preview and negative Live offset during hover/scrubbing |
| `printer-timeline-events` | Session-clock event markers, clustered event picker and accessible seek actions |
| `printer-settings` | Root/Printers/Connection navigation, keyboard access, discovery intent |
| `printer-list` | Keyed printer reconciliation, editor selection, focus after removal |
| `printer-item` | Name/IP, inline code input, save/forget actions, per-printer errors |
| `printer-context-menu` | Placement, keyboard navigation, Mini player/Stats actions |
| `printer-stats` | Diagnostics rows, frame sampling, visible/connected timer lifecycle |
| `printer-pull-indicator` | Accessible pull-to-reload indicator |

Components use light DOM. The shared theme, SVG symbols, native labels and
browser media APIs continue to work across component boundaries. Existing
playback/replay controllers retain access to their native media and range input.
The player template is rendered once, so catalog changes never recreate video,
restart hls.js, or replace the page's recording session. Player landmarks and
button labels are retained.

The camera view samples its existing media into one small decorative canvas for
the blurred background. Media events and ResizeObserver drive updates without
another decoder, media request, or timer loop. Hidden documents and a matching
aspect ratio skip drawing. Reduced motion keeps a still sample.

`PlayerElement` renders static markup once in `connectedCallback`. Each
connection gets an `AbortController` for its listeners; disconnection removes
those listeners. Reconnecting reuses child nodes and installs one set of
handlers. Supported native moves preserve focus without disconnecting. The
stats panel stops sampling when hidden, detached, backgrounded or on pagehide,
and restarts once when it becomes visible/connected again.

Printer lists accept `update(cameras, selectedCamera, busy)`. Printer rows use
data properties and `textContent` for server-provided names/IPs. Their inline
fields and unique labels stay attached across discovery updates. Separate list
instances keep independent editors. Codes live in input values and action-event
details until submitted; they are not interpolated into markup or attributes.

UI actions are synchronous bubbling/composed `CustomEvent`s: `printer-select`,
`printer-save`, `printer-forget`, `printer-scan`, `player-play`, `settings-toggle`,
`cast-request`, `fullscreen-toggle` and `player-action`. The printer list consumes
`printer-edit` locally. `static/player.js` handles the application/network
actions; UI elements do not fetch, scan, save credentials, or open recordings.
Synchronous fullscreen and Cast events retain the original click's browser activation.

Mini player uses native video PiP or Safari's presentation API. The browser
presents the same decoded video in its floating surface; no DOM tree is moved
and no additional decoder or recording is opened. The complete component tree
stays on the main page, including the header, timeline, settings, diagnostics,
toolbar and diffusion canvas. Its controls keep operating on the same media
element. Native PiP events update Restore and Activity, and keep video/metadata
streaming while the tab is hidden. Document PiP is not requested. The browser
owns the floating surface's controls/background; an in-page panel is never used
as a replacement.

`PageReplay`, `PlayerVideoStream`, `PlayerUpdates`, and the fullscreen/gesture
controllers keep their existing media, timeline, SSE and orientation behavior.
`tests/browser-components.js` covers native registration, independent instances,
safe names, labels, reconnecting editors, one action per gesture, and sampling
cleanup in Chromium and WebKit. The existing browser suites cover the player
behavior against generated footage.

Platform reference: [WHATWG custom elements and lifecycle requirements](https://html.spec.whatwg.org/multipage/custom-elements.html#custom-element-conformance).
