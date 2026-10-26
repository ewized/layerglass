---
title: Application guide
tags: [reference, player]
---

# Application guide

[Vault home](../index.md) · [Installation](../operations/installation.md) · [Development](../development/workflow.md)

## Finding and selecting printers

The server scans at startup. Opening **Settings → Printers** searches again and
adds identified, approved printers to the known list. The submenu refresh icon repeats the
search and spins while scanning. An empty list shows skeleton rows until results
arrive. Known printers stay visible during later searches, including offline
entries. The selected feed and its rewind buffer keep running while results
arrive or a different printer's connection is being edited. Scanning logs only
start and finish; **Stats for nerds** shows scan percentage.

The scan checks only approved camera ports, currently native JPEG on 6000 and
RTSPS on 322. After a camera service responds, manufacturer identity checks race.
For Bambu, these check MQTT/TLS on 8883 and camera TLS in parallel. MQTT work is
shared per host; TLS evidence and failures are kept separately for each camera
port, so a failed control/alternate port cannot hide the valid camera.
A manufacturer-CA-verified serial must map to an approved model. The
MQTT check also requires a CONNACK response; authentication refusal is sufficient
to identify the service without sending credentials. The first valid identity
wins. A model is listed only with its approved camera protocol and port: a
file/control tunnel on 6000 does not become a camera for an RTSPS model.

Discovery sends no access codes, MQTT subscriptions, status requests, or printer
commands. An open port, generic MQTT broker, unverified certificate, or RTSP/HTTP
response alone cannot add a printer. Unsupported or unidentified devices stay
out of the list. `DISCOVERY_PORTS` cannot extend the approved profiles.

Discovery uses the `/24` containing `STREAM_URL`'s private IPv4 address, or the
subnets in `DISCOVERY_CIDRS`. Set the latter when starting without `STREAM_URL`.
Only private IPv4 LAN subnets are accepted, with at most 4096 addresses and 64
simultaneous TCP connections (48 camera probes plus 16 identity checks). Routing
and firewalls must allow access to the camera subnets. Known printer IPs are
scheduled first, and overlapping subnets share one set of probes. Scans are
shared between viewers and start at most once per 10 seconds.

The server keeps a small in-memory cache: successful, approved camera results
and name lookups last 20 seconds. Failed endpoints retry on the next requested
scan after 15, then 30, then at most 60 seconds; success resets that backoff.
Failure history expires after five minutes, and the cache holds at most 8,192
endpoints. A cold name lookup listens for two seconds in parallel with camera
probes. Fresh cached decisions count toward scan progress, with the cache count
shown only in the active scan row in Stats for nerds. Console messages remain
limited to scan started/finished.

Unexpected scan errors delay the next allowed scan by 10, 20, 40, 80, then at
most 120 seconds; a successful scan resets this delay. The discover response
includes `retry_after_seconds`. These delays do not schedule automatic scans:
startup and explicit requests remain the only triggers. A newly reachable
address may wait for its short negative-cache interval before a subsequent
requested scan probes it again. Cached metadata never bypasses the approved
manufacturer/model/stream policy and contains no access codes.

Camera labels use an advertised friendly name, then the printer's serial number,
then a short camera ID. The IP/port appears separately in the printer list and
Stats for nerds. A camera ID identifies the endpoint, so it changes if its IP,
port, or transport changes; a reported serial identifies the printer itself.
Model and manufacturer information stays in Stats for nerds. Names, identities,
and saved connection settings are remembered on the server. Manufacturer
adapters can coalesce alternative protocols for the same physical printer.

Each printer row shows its name, IP/port, setup action when unconfigured, and
**Forget printer**. Selecting a configured name opens its camera immediately;
a checkmark marks the selection. The browser remembers that selection.

The key icon opens a plaintext inline LAN-code field; the checkmark saves and
connects. These actions use icons with accessible labels and tooltips, without
visible button text or an input placeholder. Each code belongs to one printer.
The server builds its approved
stream URL; the UI and API cannot change the stream path, username, port, or
protocol. No editor opens automatically. Escape closes an
editor, leaving the list clears unsaved fields, and discovery updates retain
the draft and keyboard focus. **Save and connect** switches to that camera.

Settings are saved with mode `0600` in `/data/printers.json`, backed by Compose's
`camera_data` volume. Stored credentials and private source URLs are never
returned by the API or placed in browser storage or the image. Configured
cameras hide their setup action. **Forget printer** removes its connection,
credentials, identity, relay, and temporary history for all viewers. Cached scan
results cannot immediately restore it; a later search can discover it again.
Forgetting also prevents `STREAM_URL` from restoring old credentials at restart.

Discovery cannot infer credentials or admit arbitrary stream paths. An offline
approved, saved camera keeps retrying even when a scan finds nothing. Unconfigured
candidates remain known until server restart; configured cameras survive it.

Settings version 3 loads existing printer IDs, names, codes, and forgotten
entries without re-pairing when they match an approved profile and known model.
An old source without model identity waits for discovery before playback. Old
generic source records are retained privately but never listed or started.
Previous browser selection and pending reload
metadata migrate once to generic keys. Manufacturer names and native protocol
identifiers remain accurate inside their adapters.

## Controls and recovery

The video fills the browser window, with the selected printer's model at the
top left and its serial number underneath in smaller text. If a serial is
unavailable, the second line uses the endpoint ID. Friendly names remain in
printer selection and Stats for nerds. The timeline, playback buttons, options, and fullscreen are in the
bottom toolbar. Empty space around a different video aspect ratio uses a dim
CSS gradient derived from the displayed frame; the main picture stays sharp and
uncropped. Gaussian-weighted regional colors come from a sample no larger than
32 × 32 pixels every 2.2 seconds during playback, averaged in linear-light sRGB.
Two gradient layers crossfade with a 1.8-second CSS opacity transition, with no
full-screen blur or per-frame JavaScript animation loop. It adds no stream,
decoder, or media requests. Sampling stops when the player document is hidden
or the picture fills the viewport; reduced motion keeps a still background until
a seek, resize, or source change. See [the formula and rendering notes](../video-diffusion.md).

Video uses the browser's native decoder and renderer, with hardware decoding
chosen by the browser/device when available. hls.js prepares compressed media
in a worker and feeds MediaSource; it is not a JavaScript video decoder.
ManagedMediaSource is preferred where supported. The main UI checks progress
on media events and changes the loading overlay only when playback starts or
recovers, without an application callback for every video frame.

For mobile memory use, hls.js targets 12 seconds ahead, capped at 24 seconds,
with an 8 MiB encoded-buffer target and 12 seconds behind. Distant forward
ranges are also evicted after seeking. These are buffering targets, not a cap
on total browser RAM. Full rewind history stays on the server. Stats for nerds
separates the native decoder, media pipeline, and detected video codec; it does
not claim a hardware decoder is active without device-specific evidence.
The Live button sits on the left beside Pause / Play: its dot
is green at live and gray while watching the past, with the negative replay
timer immediately to its right. Controls fade during playback; touch the video,
move the mouse, or use the keyboard to reveal them. They stay visible while
paused or while settings are open.

Hover over the scrub bar to preview a frame and its negative time offset from
Live, with the time below the image so the complete frame stays visible.
On phones, the preview appears while dragging; keyboard range changes
also show it. Previews stay within the player, including fullscreen.
Dragging previews the selection without seeking the video
or requesting historical printer stats for each intermediate position. Releasing
the pointer seeks once. Horizontal trackpad scrolling or a mouse wheel over the
bar also previews the target, committing once after 250 ms without more scroll
events. Held arrow keys preview until key release. Playback keeps its current
playing/paused state; Escape, a cancelled touch or leaving the window discards
an unfinished gesture. A committed seek opens a replacement archived stream
only when its footage is outside the browser cache.

The browser saves a 320 × 180 JPEG every five seconds from the video already
playing. A forty-five-minute session has about 540 stills, ready before hovering.
Previews read local compressed images first (32 MiB RAM), backed by session-scoped
IndexedDB (up to 128 MiB across tabs, reduced if estimated free space is low).
Only a few images are decoded at once (8 MiB); history metadata is bounded to
24 hours of five-second samples. A labelled still stays visible while another
image is read/decoded; its actual negative timestamp appears below the image.
No second video decoder, preview stream or continuous frame callback is created.

Periods not decoded locally (background, pause, Cast) or evicted from browser
storage use the existing backup endpoint. It returns six five-second samples in
one 3 × 2 JPEG sprite. Cropping/revisiting its cells stays local. Pointer movement
coalesces into at most one backup request at a time, with a ten-second failure
cooldown and no polling or speculative HTTP warming. The server retains its
bounded 128-sheet / 16 MiB cache and two thumbnail workers.

These session media images are separate from the PWA app-shell cache; development
code caching stays disabled. Closing/changing the page buffer clears its local
history; abandoned disk records expire after 24 hours. The server still retains
the full video for actual rewind playback outside the small native decoder
buffer. Details and research: [docs/local-previews.md](../local-previews.md).

The **Settings** gear opens above the bottom
toolbar, with icon rows and back navigation. **Printers** contains discovery,
selection, and access-code setup. An empty printer list shows skeleton rows
while discovery is running, then displays results as they arrive. Known printers
remain visible during subsequent scans. **Backend** selects Docker, Demo or
Direct from printer-style rows, with inline address confirmation and a checkmark
on the current choice. The parent Settings menu contains one **Refresh viewer**
action. Close settings with the gear, a tap on the video, or Escape.
All settings stay within the player, including fullscreen.
The scrub bar uses the same 6 px track, 16 px handle and 44 px interaction area
on every screen size, with shared browser styling and a fill that follows the
displayed timeline. Native range input keeps keyboard and touch support.
Pause and Play use SVG icons. Loading shows a spinner; operational messages are
logged at the appropriate console level, with repeated unchanged states
suppressed. Screen-reader status and concise input-validation feedback remain.

**Cast** sits between Settings and Fullscreen. It opens the browser's Cast or
AirPlay picker on supported browsers and stays disabled for JPEG feeds and
browsers without a casting API. Desktop Chrome on HTTPS uses Google's Cast
sender and Default Media Receiver: it sends the real HLS playlist, rather than
the local decoder's uncastable blob URL. The SDK prepares once when an HLS
source attaches; Safari keeps its native AirPlay picker and an HLS alternative
alongside the efficient local stream. The receiver must be able to reach the
viewer URL. Play/pause, rewind and Live control the receiver while casting;
local decoding pauses after a successful load and resumes with the same decoder
and page buffer on disconnect. Closing the picker leaves local playback running.
Receiver access headers apply only to HLS playlists/segments, never settings or
telemetry APIs. Details and validation are in [docs/casting.md](../casting.md).
Browser/OS media controls receive the printer model/ID, artwork and playback,
rewind and native PiP actions. Chrome may omit silent camera video from its
media panel until PiP or casting is active; the browser determines visibility.

Right-click the player to open its themed context menu, containing only
**Mini player**, **Stats for nerds**, and **Copy debug info**, available only in this menu.
Mini player uses native video Picture in Picture, through the standard video
API or Safari's presentation API. The browser controls the floating video's
buttons and background. The header, timeline, settings, Stats for nerds and
custom page toolbar stay on the main page, along with diffusion in unused space.
Document PiP is not requested, even when the browser supports it. No extra media
element, decoder or recording is created. The main page's controls still pause,
rewind, and return the same video to Live while it plays in the native window.
On the MediaSource pipeline, native PiP marks LIVE only while following Live.
Pausing or rewinding changes the native duration to the available recording;
resuming past footage stays in replay until Live is selected again. Duration
changes wait for buffer appends and retain all buffered frames.
If native video PiP is unavailable, the menu action is disabled; a rejected
request keeps the player on the page and logs the failure.
Restore exits PiP without fullscreen, restarting playback, or losing history.
The Activity section and Restore icon also follow the browser's own PiP
entry/exit events. Playback and metadata stay connected while the native window
is active, including when the original tab is in the background.
Stats are grouped under **Video** and **Printer** subheadings. A third
**Activity** section appears only while a printer scan or mini player is active.
It shows scan progress during scanning and mini player status during mini mode;
each row disappears when that activity ends, along with the empty section.
Video shows actual resolution, frames/drops, measured frame rate,
buffered video, page history, live delay, estimated HLS bandwidth where available,
and media bit rate. Printer shows a compact set for quick diagnosis during a
print: connection, model/firmware, camera IP/port, job/state, progress, layers,
elapsed/remaining time, nozzle/bed/chamber readings, active nozzle, speed, fans,
Wi-Fi and errors. Current/target temperatures share one row with °C and °F;
layers, speed/mode and fan speeds are also combined. Labels still derive from
internal keys. These use a shared local MQTT connection with the printer's saved
code. Credentials and stream URLs stay private.
Unavailable values display a dash. Missing/stale telemetry is indicated inside Stats and
does not interrupt video. [Protocol details and research](../printer-telemetry.md).
Printer readings follow the watched video's timestamp: pausing holds them,
rewinding selects historical readings, and Live catches up with live footage.
Each new page session records its own accessible history. Uncached older seeks
can fetch a small server history window; recent readings use the existing SSE
connection and bounded phone memory.
Stats refresh locally only while open and add no network polling. Native loop/show-controls context
actions are suppressed for the custom menu; the page keeps our custom controls.

**Copy debug info** in the same context menu writes a formatted JSON snapshot
to the clipboard. It includes every public printer field, including nested
manufacturer/AMS/sensor/module/flag data, plus browser, camera, stream and native
video diagnostics. Current live readings and cached readings for the watched
timestamp are separate; missing recorded data is explicitly null. Copying does
not fetch more history, scan, start PiP, or restart playback. It works while the
Stats panel is closed. A checkmark confirms success; failures keep a retry action
and log the error without logging the report. The modern clipboard write starts
inside the click callback for Safari activation; ordinary HTTP pages use a
selected-text copy fallback. Details and sources are in
[docs/debug-info.md](../debug-info.md).

- **Timeline** scrubs through footage collected since this page opened.
  Live stays at the right edge. During normal replay, both ends of the visible
  window move with Live, so playing one second while capturing one second keeps
  the thumb in the same relative position. Pause and held drags keep their view
  steady. Touching the bar or using its keyboard controls fits all retained page
  history before seeking; older footage remains stored as the visible window
  moves. **Live** restores the latest full view. Storage-limit trimming can still
  remove the oldest footage. The live clock bridges segment updates, with a
  bounded prediction that never expands what is actually seekable.
- **Pause / Play** stops or resumes playback while new footage keeps buffering.
- **Live** returns to the current camera feed.
- The playback timer appears only when watching past footage and shows a negative
  offset from live, such as `−0:32`. Live playback has no timer or total duration.
- **Refresh viewer**, in the main Settings menu, reconnects playback and keeps
  this page's buffer. With a configured Docker camera it also restarts the
  camera connection for all viewers. Direct mode refreshes its controller and
  live camera; Demo refreshes local playback. It does not reload the page.
- **Pull down on the video** on mobile, then release when prompted, to reload
  the whole page and return to live playback with a fresh buffer. A temporary
  indicator appears inside the player during the gesture. Short pulls, timeline
  gestures, open menus, and pinch gestures do not reload. The selected camera and
  a one-time autoplay intent travel in `history.state.printerCameraReload`; the
  player consumes that intent on reload and starts muted, inline video once
  media is ready. If the browser requires a tap, **Play live view** remains
  available. No footage or access codes are carried in this state.
- **Fullscreen** requests fullscreen for the whole player, retaining its custom
  toolbar, timeline, and settings. On iPhone, where whole-player fullscreen is
  unavailable, tapping the button requests native **video fullscreen** instead.
  That surface uses Safari's controls; Done returns to the custom player with
  the same decoder and rewind history. On touch devices, rotating to landscape
  requests whole-player fullscreen and rotating back to portrait exits either
  fullscreen mode. Automatic rotation keeps the custom controls in an expanded
  browser-window view when whole-player fullscreen is unavailable; its button
  still offers real video fullscreen. Browser bars can remain visible in the
  expanded view. If rotation requires a gesture, tap the video to retry
  whole-player fullscreen. Escape closes the expanded view after any open
  options. Desktop resizing never triggers it.
- The relay retries a lost connection with a 3–30 second backoff. If the
  camera stops producing HLS segments for 30 seconds, the relay reconnects.
- The player automatically recovers from playback errors and stalled video.
- The live relay keeps a short rolling window in a 128 MB memory-backed `/tmp`.
  Rewind history uses temporary disk storage in the separate `camera_buffer`
  volume, collecting video only while a page has an active session.

Each tab has its own starting point. Reloading the page or selecting another
camera starts a fresh buffer. Pausing, seeking backward, or refreshing just the
player continues collecting footage; buffered history also survives a camera
reconnect. HLS boundaries can include the last segment at page load, usually a
few seconds. Native Bambu JPEG cameras retain frames for the same controls.

Footage shared by multiple open pages is stored once per camera. Closing or
leaving a page releases its history; if the browser disappears without sending
the close request, its session expires after 30 minutes without a heartbeat.
All temporary history is cleared on server startup and graceful shutdown.
The default total buffer cap is 8 GiB. When reached, the oldest footage is
trimmed and the page says so. Adjust `REPLAY_MAX_MB` for longer viewing sessions.

## Live updates and network traffic

Each visible player keeps one **server-sent events (SSE)** connection to
`/api/events` for camera status, scan progress/results, and its page's replay
metadata. It sends a full snapshot when connecting, then only changed fields;
uptime and segment-age counters do not generate repeated events. A heartbeat
every 15 seconds keeps the connection alive. The open stream renews the page
buffer's lease while it is connected.
Changing camera or creating a new buffer replaces the subscription, so several
completed event requests during initial setup are normal. A steady stream stays
open and appears as **Pending** in the browser's Network tab.

The printer list loads with the initial snapshot. There is no recurring
printer-list fetch or discovery timer in the page. Network discovery runs at
server startup, when the Printers submenu is opened, and when its refresh icon
is pressed; reading cached discovery results
does not probe the LAN. Scans and saved configuration changes push updated
results. Viewer commands remain occasional POST requests.

Hidden pages close their data connection and reconnect on return. Network
recovery resubscribes with the same camera and replay session, preserving pause
and history. If SSE is unavailable, one combined `/api/snapshot` request every
15 seconds replaces the old three polling loops. A failed stream gets a
10-second grace period before polling; healthy SSE makes no polling requests.

Video uses one persistent binary HTTP response at `/replay/<session>/video`
on browsers with MediaSource/ManagedMediaSource and fetch response streaming.
New camera fragments and index changes are pushed through that response;
hls.js reads them through a custom loader, so steady playback makes no
playlist or segment HTTP requests. Rewinding outside the small browser cache
repositions the connection at the requested archived segment. This also streams
past playback rather than fetching each archived segment separately.

The browser cache is bounded to 24 fragments / 16 MiB (one larger fragment is
allowed, up to 32 MiB). Older footage remains in the existing page-scoped disk
buffer. Archived delivery has a short prefetch burst and then runs at 1×, so a
long rewind does not download the entire recording at once. Hidden pages close
their video response and cancel hls.js loading deadlines. Reconnection preserves
the page session and buffered decoder state. Decoder errors rebuild continuous
playback; they do not permanently change the delivery protocol. Three consecutive
HTTP stream failures can temporarily fall back to ordinary HLS; receiving valid
media resets that failure count. While watching Live, a quiet stream probe after
one minute can restore continuous delivery, using the already-open probe response.
Failed probes preserve the working player and back off to two, four, eight and
then fifteen minutes. Hidden/offline pages and active Cast sessions cancel probes;
paused/replayed footage waits until Live before upgrading. Older Safari without
ManagedMediaSource retains native HLS. HLS fallback still makes playlist/segment
requests. Native JPEG cameras retain frame requests.

H.264 video is copied without re-encoding in the default configuration. Changing
to another codec would not remove HLS's request pattern; the transport change
removes the repeated requests without reducing picture quality or adding NAS
encoding work. Video bytes and existing segment/keyframe latency still remain.
Stats for nerds identifies HTTP stream versus HLS and shows the encoded media
bit rate for the stream, rather than presenting cache reads as network speed.

Ordinary short responses can reuse HTTP/1.1 connections. Both video streaming
and SSE work at the existing LAN HTTP address, without HTTPS, HTTP/2, or a
WebSocket dependency. Streaming responses disable proxy buffering through
`X-Accel-Buffering: no` and use `Cache-Control: no-store, no-transform`.
Implementation details, compatibility, research, and measurements are in
[docs/video-delivery.md](../video-delivery.md).

HTTP/2 Server Push is not used: Chromium removed support, and its resource
preloading model does not provide the page's state-event subscription.
See the [SSE standard](https://html.spec.whatwg.org/multipage/server-sent-events.html),
[Chrome's HTTP/2 Push removal](https://developer.chrome.com/blog/removing-push),
and [HLS client behavior](https://www.rfc-editor.org/rfc/rfc8216#section-6.3.4).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `STREAM_URL` | empty | Optional approved printer stream URL, including its LAN access code; identity must also be known or discovered |
| `DISCOVERY_CIDRS` | printer's `/24` | Comma-separated private IPv4 LAN subnets; set explicitly if `STREAM_URL` is empty |
| `DISCOVERY_PORTS` | approved profiles | Optional pairs must already match the approved list; cannot add arbitrary ports |
| `CAMERA_DATA_DIR` | `/data` | Writable directory for server-side saved access codes |
| `REPLAY_BUFFER_DIR` | `/buffer` | Writable temporary video directory; use a separate volume |
| `REPLAY_MAX_MB` | `8192` | Maximum total temporary replay storage, in MiB; oldest footage is trimmed at the limit |
| `REPLAY_SESSION_TIMEOUT_SECONDS` | `1800` | Release history after this many seconds without a page heartbeat (10–86400) |
| `VIEWER_PORT` | `8099` | NAS port exposed by Compose |
| `PWA_CACHE_ENABLED` | `0` | Network-only UI for development; set `1` for the offline shell |
| `VIEWER_BIND_ADDRESS` | `0.0.0.0` | Host address used by Compose's port mapping |
| `STREAM_MODE` | `copy` | `copy` remuxes H.264 without re-encoding; `transcode` converts video to H.264 |
| `STALE_TIMEOUT_SECONDS` | `30` | Reconnect after this many seconds without fresh HLS segments (10–600) |
| `RECONNECT_DELAY_SECONDS` | `3` | Initial retry delay (1–30); increases to a maximum of 30 seconds |
| `TRANSCODE_FPS` | `15` | Output frame rate in transcode mode only (1–60) |
| `PORT` | `8080` | HTTP port inside the image; keep at 8080 with the supplied Compose file |

Keep this viewer on your LAN. Every user who can reach its web port can view
cameras, scan the configured subnets, save access codes, and reconnect relays.
Untrusted cross-origin mutations are rejected. An exact origin listed in
`VIEWER_ALLOWED_ORIGINS` can use the viewer and setup APIs; POST requests still
require `X-Viewer-Request: 1`. See
[hosted frontend configuration](../architecture/backend-providers.md#hosted-app-connecting-to-a-local-container).
RTSPS uses TLS encryption and accepts the printer's self-signed certificate;
the video relay does not verify the camera certificate. Admission to discovery
requires a separate manufacturer-verified identity check.

## Direct Docker alternative

```sh
docker build -t local/layerglass:0.1.0 .
docker run -d --name layerglass \
  --restart unless-stopped --init --read-only \
  --tmpfs /tmp:rw,size=128m,mode=1777 \
  -v layerglass-data:/data \
  -v layerglass-buffer:/buffer \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --env-file .env -p 8099:8080 \
  local/layerglass:0.1.0
```

## Maintenance

```sh
docker compose logs --tail=50
docker compose restart
docker compose down
```

If the page loads but video does not, check that the printer is powered on,
that the NAS can reach its camera port, and that the access code is current.
If the source codec is not browser-compatible H.264, set `STREAM_MODE=transcode`
and apply it with `docker compose up -d`. Transcoding uses more CPU.

HLS normally adds a few seconds of delay, depending on the camera's keyframe
interval. This is a monitoring viewer rather than an instant control channel.
