---
title: Debug clipboard snapshot
tags: [technical]
---

# Debug clipboard snapshot

[Vault home](index.md)

The player context menu has **Mini player**, **Stats for nerds**, and **Copy
debug info**. Settings stays focused on printer selection and connection actions.
The quick panel displays print and playback diagnostics. The full public printer
report is copied only when requested, as indented JSON with `schema_version: 1`.

The report includes:

- The capture time and browser environment: user agent, language, online/secure
  context, visibility, viewport and pixel ratio.
- Public camera identity, manufacturer, model and endpoint IP/port.
- Playback mode/time, history bounds, recorded-data availability, fullscreen and
  native PiP state.
- Native video resolution, codec, pipeline/delivery, ready/network state, frames,
  dropped frames, rate, buffer/seekable ranges, bit rate and error code.
- A small server stream summary and discovery state/counters.
- Complete public `printer.live` and `printer.displayed` objects, including all
  nested manufacturer fields; `displayed` uses the watched video's timestamp.

Uncached recorded data is null, with `recorded_printer_available: false`. Current
live data is never substituted for a missing recorded sample. No history request
or LRU cache change occurs during copying. The copy never scans or changes the
stream, playback, recording session or PiP state.

The printer trees already use the server's bounded public-field filtering. The
export selects camera/server/browser metadata explicitly, excluding private
sources, credentials, page query strings and recording access tokens. It never
logs the report or uploads it. Clipboard contents are written only after the
user invokes the menu action. No clipboard-reading permission is requested.

On HTTPS, `navigator.clipboard.writeText` starts synchronously in the original
click callback, before awaiting anything. This preserves the gesture required
by [WebKit's async Clipboard API](https://webkit.org/blog/10855/async-clipboard-api/).
The API returns a promise and requires a secure context, as described by
[MDN's writeText reference](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText).
If the API is absent on a LAN HTTP page, a temporary read-only textarea and
`execCommand('copy')` provide a best-effort fallback. Selection/focus are restored
and the temporary node is removed, including on failure. A rejected native write
is reported, not retried with another permission path.

The menu briefly shows a checkmark and **Copied**, then closes. Failure leaves
**Try copying again** and a console warning with the error type. Reopening the
menu resets feedback; a late result cannot close a newly opened menu. Copy logs
contain only success/failure, never printer data.
