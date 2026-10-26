---
title: Live timeline behavior
tags: [technical]
---

# Live timeline behavior

[Vault home](index.md)

The bar is a live DVR control. It does not show a percentage of a finished video.

Observed printer changes appear as [print-event markers](timeline-events.md),
using the same recorded clock and range input mapping. Their small touch targets
stay above the slider.

## Why the previous model moved

Freezing the end of the timeline made the playhead move toward that end during
replay, even though the camera continued recording. Dividing playback time by
the entire growing archive would also drift: `50 / 100` and `51 / 101` differ.

For a moving window with fixed width `W`, live edge `L`, and playback time `P`,
the thumb fraction is:

```text
window start = L - W
fraction = (P - (L - W)) / W = 1 - (L - P) / W
```

When both `P` and `L` gain one second, their difference remains constant, so the
thumb stays at the same fraction. Faster playback moves it toward Live; stalled
playback falls behind. The player must keep decoding normally rather than seek
or change playback speed to make the bar appear stationary.

## What platforms and established players do

- YouTube documents DVR pause, rewind, and resume from the paused point within
  the available history. Its help page describes DVR limits, not a thumb-position
  algorithm, so it is evidence for playback behavior rather than the equation.
  [YouTube live DVR](https://support.google.com/youtube/answer/9296823?hl=en)
- Google Cast models a live seekable window with separate start, end, and moving
  state. Its documented example advances a 600-second window from `[0, 600]` to
  `[10, 610]`. It also notes that segment production makes range updates arrive
  in steps. [Google Cast live streaming](https://developers.google.com/cast/docs/web_receiver/live)
- Video.js provides a live-edge tracker, negative offsets from Live, and a return
  to Live control. Its clock estimates live time between seekable-range updates
  using elapsed monotonic time.
  [Video.js live support](https://legacy.videojs.org/guides/live/),
  [LiveTracker source](https://docs.videojs.com/live-tracker.js.html)
- Shaka's seek bar calculates its playhead fraction against the seekable window,
  rather than an assumed final duration. This supports a stable fraction when
  the window and playback advance together.
  [Shaka seek-bar source](https://shaka-project.github.io/shaka-player/docs/api/ui_seek_bar.js.html)

These sources describe the live-edge/window model. The following archive and
interaction choices are specific to this viewer.

## How this viewer applies it

- Live pins the thumb to the right edge, regardless of normal decoding latency.
- Starting a replay fits the retained page history, then moves that window with
  the live clock. The view's width stays fixed during uninterrupted playback.
- Pause freezes the view and selected frame while recording continues. Resume
  fits the current history once, then follows the moving-window rule again.
- Beginning a pointer or keyboard seek fits all retained page history. A held
  drag freezes the mapping underneath the pointer. Thus older history stays
  reachable even after the displayed window has moved past it.
- Display time advances between HLS segment reports. Prediction is capped at six
  seconds past the newest observation and stops on a reported stream error.
  Native demo/local files also stop at their known media duration, including at
  the final paused frame. Seeking is independently clamped to available media.
- Retention trimming can move the earliest available point. Page/session reset
  clears the clock, window and JPEG frame-request deduplication. A replacement
  camera requests its own replay frame even at the same timestamp. Temporary
  recording and its storage cap are unchanged.

`apps/layerglass/tests/timeline.test.js` exercises the actual browser controller with a fake
clock and media inputs. The core regression first failed with a movement from
50% to 51% after one second; it now remains at 50% through two minutes of matched
playback and recording. Browser tests additionally check real decoding, capture,
and thumb drift in Chromium and WebKit.
