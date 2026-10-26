---
title: Printer telemetry
tags: [technical]
---

# Printer telemetry

[Vault home](index.md)

Discovery uses bounded identity checks before admitting an approved printer;
the Bambu adapter can identify an MQTT service without sending an access code.
Live printer telemetry is separate and starts after pairing. Adapters opt in
through `telemetry_supported` and `create_telemetry`. Unapproved generic cameras
are never listed, paired, or given a telemetry connection.

Stats for nerds uses a compact selection of normalized readings under
**Printer**: connection, model/firmware, IP/port, job/state, progress, layers,
elapsed/remaining time, temperatures, active nozzle, speed, fans, Wi-Fi and
errors. Current/target temperatures, layer counts, speed/mode and fan speeds are
combined to keep the panel short. Labels come from internal keys, and original
keys remain in tooltips and stable DOM identities. Zero remains a valid reading.
No HTML from a printer is interpreted.

The complete public object remains available through **Copy debug info** in the
video context menu. Its JSON includes the `reported` tree of manufacturer fields
with their original names and structure: unknown future fields, sensors, AMS/tray
arrays, firmware modules, flags, job IDs, booleans, zero, null and empty arrays.
The report separates current readings from cached readings for the watched
timestamp. Copying uses `PrinterHistory.peek`, which never creates/fetches a
history window; an uncached timestamp stays explicitly unavailable. See
[debug export](debug-info.md) for the report and clipboard behavior.

Manufacturer, IP, port, name and printer ID describe the selected endpoint.
Decoded nozzle, bed and chamber readings/targets show °C and °F. Duration and fan
percentage fields retain their units; unknown packed fields remain literal
values rather than being assigned guessed units. Unknown values display a dash.
Camera labels use an advertised friendly name, then the printer's serial number,
then a short camera ID. The fallback camera ID identifies the network endpoint,
not a physical printer, and changes with its IP, port, or transport. IP and port
remain on the secondary printer-selection line and in Stats for nerds.

The **Printer** readings follow the video being watched. Pausing holds the
recorded progress, layer, job, temperatures and remaining time; rewinding selects
older readings; Live selects readings for the live video's timestamp, including
its camera/decoder latency. The current server status continues receiving MQTT
updates independently. Unknown history displays a dash instead of substituting
the latest printer values.

Elapsed print time follows the same recorded clock, so it also stops when the
video is paused and rewinds with the footage. It is available only when the
adapter knows the job's start time or observes a new print start. Joining an
already-running job without that information shows a dash; a changing remaining
time estimate is not used to invent an elapsed time. Optional hardware readings,
including a second nozzle and fans, appear only when the printer reports support
or values. Changing printer removes rows unsupported by the new selection.

While a page owns a video buffer, its shared server archive samples only the
adapter's complete public object at approximately 1 Hz. Samples use the
server's wall clock, matching the HLS program-date-time clock. hls.js exposes
the playing frame's date through `playingDate`; native HLS can use its start
date, with recorded clock anchors as a fallback. Anchors preserve relay restart
gaps. JPEG replay uses its recorded frame timestamps. Each still holds until the
next capture, including a reconnect gap; the recorded clock and printer readings
advance through that hold. A new capture finalizes the preceding interval and
starts its own provisional one-second tail. This does not interpolate images or
readings, and the latest JPEG clock stays bounded by its last capture time.
Later pages keep their actual opening-time origin, independent of that tail;
their first available image can arrive later, and pre-page readings stay hidden.

The JPEG archive endpoint includes a provisional tail, so its end is not the
decoded still's timestamp. The viewer binds recorded readings to the precise
position of its current owned image request after native decoding. Live pause
freezes that image and clock through later captures and metadata. Requests into
an unproven tail clamp to the latest accepted capture; a completed held interval
keeps the selected position's wall time rather than jumping to capture start.
An older metadata snapshot or stale image completion cannot replace this
ownership. While pixels are unowned, including compatible legacy JPEG playback,
recorded readings stay unavailable instead of borrowing the current printer
reading. A temporary same-session reattachment retains its proven paused clock.

The existing SSE subscription sends an initial recent window and then small
incremental sample batches, scoped to the page's session. A later tab cannot
receive readings from before it opened. The phone retains at most eight
two-minute windows. An uncached seek or opening diagnostics can request one
window at `/api/sessions/<session>/printer?at=<epoch-seconds>`; normal rendering
does not poll this endpoint. Reconnect gaps can be hydrated on demand. Historical
values use the latest sample at or before the displayed time, without inventing
intermediate progress or counting down old estimates.

Superseding an unfinished history request releases that window for a later read,
without waiting for the aborted response to settle. This also lets receiver-side
Cast position changes return to a canceled window and recover its readings.
Concurrent reads of the current window still share one request. Late canceled
responses cannot change a newer request or another session. HTTP failures and
timeouts stay suppressed until an explicit retry, so rendering does not become
an outage polling loop. Local seeks already trigger that retry through the
Stats replay/seek handlers, as do opening Stats and reconnecting the network;
receiver-side clock changes do not emit those local seek events.

A successful history response can cover only the part of a two-minute window
that has been recorded so far. After an SSE reconnect, later accepted sample
timestamps can establish that a missing point in that window is now in the
recorded past. Reading that point may then hydrate the window once. Query range
endpoints alone, empty future responses and other-session packets do not prove
recording progress. Pending reads still share one request. A completed hydration
that still misses its target stays suppressed until explicit retry, rather than
repeating on every render or SSE sample; real failures keep that same suppression.

Telemetry is pruned with discarded footage and deleted when its archive loses
its last page lease or the printer is forgotten. Snapshots are compressed in
server memory, then expanded to ordinary JSON for HTTP/SSE. A 43,200-sample limit
(about twelve hours at 1 Hz) and a 32 MiB compressed-data/entry budget per archive
bound metadata storage; larger reports can shorten retained telemetry history.
Older missing readings stay unknown. This history is temporary server/browser memory, never persistent
settings or the service worker's offline cache. Synchronization is limited by
the printer report cadence and camera transport timing.

`apps/backend/tests/test_printer_history.py` covers immutable nested samples, compression,
byte/count limits, program
clocks and reconnect gaps, incremental updates, session isolation, pruning,
bounds, uncached HTTP responses and expiration. `apps/web/tests/printer-history.test.js`
checks playhead lookup, pause, zero/future values, cache limits, cancellation,
same-window/session ownership, timeout suppression, gaps and recovery without
polling. `apps/web/tests/browser-printer-history.js` uses
`apps/backend/tests/fixture_server.py` with `FIXTURE_TELEMETRY=1` to check changing readings
through real Chromium/WebKit video playback, pause, rewind, forward replay and
Live. Set `TRANSPORT=hls` to exercise HLS fallback.
The default `browser-history-reconnect.js` fixture connects the actual Stats,
PageReplay, PrinterHistory, Cast sender and metadata-update consumers. Generated
HTTP/SSE payloads check receiver-originated recovery after a partial success,
with future-point, pending-read, full-cache and local-seek controls. Chromium
uses a synthetic Cast SDK; WebKit checks the shared history clock with an adapter
and remains ineligible for Google Cast. This does not verify receiver hardware.

Clock references: [hls.js playingDate](https://hlsjs.video-dev.org/api-docs/hls.js.hls.playingdate),
[HLS program date time](https://www.rfc-editor.org/rfc/rfc8216#section-4.3.2.6).

Telemetry clients share one connection per saved camera. Each supplies
`start()`, `close()`, and `status()`, and can send sanitized identity updates
through its callback. Losing telemetry does not restart or interrupt video.
Credentials stay paired with that printer on the server. Shared public-field
filtering removes credentials, stream URLs, unsafe object keys and non-finite
values. Entries whose keys contain a saved code or URL are omitted too, before
they consume the public snapshot budget. A snapshot is bounded to 64 KiB,
4,096 nodes and 16 nested levels, with individual strings limited to 2,048
characters. Large integer identifiers are
sent as strings so browser numbers cannot round them. These are diagnostic
readings, not an unfiltered MQTT capture.

The current manufacturer implementation is the
[Bambu adapter](reference/bambu-telemetry.md). Its certificate verification,
MQTT reports, model mapping, and SSDP enrichment are contained there.
See [Camera adapters](camera-adapters.md) to add another manufacturer.
