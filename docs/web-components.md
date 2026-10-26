---
title: Player UI components
tags: [technical]
---

# Player UI components

[Vault home](index.md)

The UI uses native autonomous custom elements, registered by
`apps/web/src/components/index.js` through the existing ESM entry point. The page has
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
| `printer-settings` | Root/Printers/Backend navigation, keyboard access, discovery intent |
| `printer-backend-list` | Current-backend checkmark, inline address editing/confirmation and backend selection intent |
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

Backend selection uses the same row/inline-editor pattern as printers. Opening
the Backend page shows the current choice without opening an editor. Docker and
Direct addresses are confirmed beside the input; Demo selects directly. Drafts
do not replace the current backend until validation succeeds. The root Settings
page has one Refresh viewer action: Docker restarts its camera relay and
reattaches playback, Direct refreshes the verified controller/camera connection,
and Demo reconnects its local player. This does not reload the page or create a
new recording session.

A rejected Settings backend check restores the submitted address input only
when that same editor remains open on the visible Backend page and its focus
was lost to the document during the check. Moving focus, dismissing Settings or
replacing/disconnecting the editor prevents that restoration. Drafts and errors
remain available for an explicit retry; a successful selection keeps its normal
save and reload behavior.

The first-visit backend chooser locks its address during the bounded connection
check. Keyboard focus moves to Back so Escape and Back can still cancel; a
failure or timeout restores editing. A cancelled check cannot select or save a
backend later.

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
Rejected setup restores a submitted editor's keyboard focus only while that
same editor remains open on the visible Printers page. Moving focus, dismissing
the editor or leaving the page cancels that restoration. An editor left open
keeps its draft and error without reclaiming another control's focus.

The context menu's initial focus and arrow navigation use only visible, enabled
actions. Keyboard activation of Stats moves focus into the panel, and keyboard
dismissal returns it to the player. Pointer activation keeps its existing focus
behavior. These handoffs do not make diagnostics modal or change their sampling
lifecycle.

Successful Copy debug info feedback still dismisses after one second. It returns
focus to the player only while the menu retains focus, so a later keyboard action
on the timeline or another control continues without interruption.

UI actions are synchronous bubbling/composed `CustomEvent`s: `printer-select`,
`printer-save`, `printer-forget`, `printer-scan`, `player-play`, `settings-toggle`,
`cast-request`, `fullscreen-toggle`, `backend-save` and `player-action`. The printer list consumes
`printer-edit` locally. `apps/web/src/player.js` handles the application/network
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
`apps/web/tests/browser-components.js` covers native registration, independent instances,
safe names, labels, reconnecting editors, one action per gesture, and sampling
cleanup in Chromium and WebKit. The existing browser suites cover the player
behavior against generated footage.
`apps/web/tests/browser-keyboard-focus.js` covers available menu actions,
keyboard Stats handoffs, copy-feedback focus ownership, held onboarding checks,
and rejected printer/backend setup focus ownership
with actual Chromium/WebKit keyboard events and generated responses.

Platform reference: [WHATWG custom elements and lifecycle requirements](https://html.spec.whatwg.org/multipage/custom-elements.html#custom-element-conformance).
