---
title: Print events on the timeline
tags: [technical, player, telemetry]
---

# Print events on the timeline

[Vault home](index.md) · [Live timeline](live-timeline.md) · [Recorded telemetry](printer-telemetry.md)

The player shows small print-event markers above its existing scrub bar. The
same controls and layout serve touch and desktop. A marker describes an observed
start, pause, resume, finish, explicit cancellation, failure, new error or job
change. Its tooltip/picker shows a negative offset from Live; activating an event
commits one seek to that recorded video position. Hover and keyboard focus do
not seek or fetch data. Markers do not cover the range input's touch target or
replace thumbnail previews.

Nearby events share a marker and open a short timestamped menu, so a quick
pause/resume stays reachable on a phone. Tab reaches one marker; Left/Right and
Home/End navigate markers. In a grouped menu, Up/Down and Home/End navigate
observations, Enter/Space activate, and Escape returns focus. Native buttons
supply touch and assistive activation. Labels use text nodes rather than printer
HTML. Timeline controls continue to operate the same video decoder and session.

## Data and evidence

`apps/layerglass/src/timeline-events.ts` exports the transport-independent
`PrinterTimelineEvents` model. `PrinterHistory` supplies accepted session resets
and telemetry batches through optional `onSession` and `onSamples` callbacks.
No additional endpoint, timer or poll loop is introduced. A Python, demo or
browser provider can use the existing envelope:

```js
{
  session_id, camera_id, from, until,
  samples: [{ at, printer: { connection: 'connected', print_state: 'RUNNING' } }]
}
```

The [demo backend](architecture/backend-providers.md) seeds three minutes of
recorded simulated readings on subscription. Its start, pause and resume markers
use this same model and recorded video clock; they are not separate UI fixtures.
The finite demo's finish event appears when the simulated live edge reaches it.

`at`, `from` and `until` are epoch seconds, matching recorded video clock
anchors. Event summaries contain `{ id, type, at, label }`, with generic labels
and no credentials or raw manufacturer reports. The model accepts normalized
`print_state`, `job`, `error`, and optional `reported.print.subtask_id`/`task_id`
identity evidence. It merges partial observations without guessing missing
fields. An explicit unknown state breaks state-transition evidence. A duplicate
timestamp may enrich the baseline but cannot establish the order of conflicting
states/errors at that instant.

Joining an already-running print does not create a fictional start event.
PREPARE/RUNNING/PAUSE after an observed terminal state establishes a start;
PREPARE to RUNNING is the same print. Explicit cancelled and failed states are
distinct; IDLE alone is insufficient to infer cancellation. A new name/job ID
while active is labelled a job change, since its precise start was not observed.
A nonzero error is a new event only after a known different code. Failure and
its error code do not produce two markers for one failed observation.

Connection loss, stale/unknown connection state or more than 15 seconds between
samples resets transition evidence. A reconnected initial window can recover
transitions contained in that window, but cannot assert when a transition
happened inside a missing gap. Older history windows can add their own observed
events; they cannot compare their first sample with the latest live baseline.
Overlapping SSE/history batches deduplicate by observation time and event type.
Event timestamps describe when the change was observed, limited by printer
report cadence and archive sampling; they are not exact mechanical event times.

## Clock, bounds and retention

`timelinePosition` maps each event through the session's recorded `clock`
anchors. An anchor's segment stops at the next anchor's video position, so a
relay restart gap cannot be projected onto unrelated video. Future observations
wait until their media is recorded. Providers without a matching clock/history
simply show no markers.

Rendering uses the range input's actual min/max, including its frozen mapping
while dragging and its moving replay window. Markers outside that display
window remain available when the user fits the complete history for a scrub.
Discarded footage removes its older events. Changing camera/session, closing or
reloading the page removes all associated event evidence.

Local JPEG markers also require proven replay coverage. When the controller
returns an accepted owned JPEG descriptor, the component passes its precise
clock and retained start/end as a temporary session view to the event model.
This keeps fractional event positions and retention aligned with the recorded
stills without changing either session object or the global clock model.
The provisional latest-frame tail and predicted slider edge do not prove that
an observation is seekable. A future summary stays pending until a successor
capture completes its held interval; its observation time is never moved to
the still's capture time.

Rendering and activation intersect that proven coverage with the displayed
slider window. Placement and negative offsets still use the original display
mapping, including a frozen scrub window. Activation resolves the current event
by ID and commits/emits its freshly mapped position, so a stale marker or menu
cannot request an earlier clamped frame. Descriptorless/invalid JPEG, remote
playback and video/file sessions retain their existing behavior. This does not
reconstruct summaries already discarded before the precise view was available.

The model retains at most 512 small summaries and one compact latest baseline,
independently of the eight-window diagnostic cache. A 45-minute open page does
not lose its early markers just because newer telemetry evicts old diagnostic
windows. An unusually noisy printer can evict the oldest markers before its
video is trimmed. Event summaries are temporary page memory, not IndexedDB,
persistent server settings or the PWA cache. The server still owns DVR media.

`apps/layerglass/tests/timeline-events.test.js` covers observed transitions, absent/partial data,
job identities, duplicate and conflicting timestamps, reconnect gaps, clock
mapping, page isolation, moving windows, retention and bounded memory.
`apps/layerglass/tests/browser-timeline-events.js` checks generated-video integration in Chromium
and WebKit: labels, clustered touch/keyboard access, single committed seeks,
unchanged slider gestures and no additional telemetry requests.
