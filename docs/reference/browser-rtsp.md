---
title: Browser-direct RTSPS feasibility
tags: [reference, research, video, web]
date: 2026-10-25
---

# Browser-direct RTSPS feasibility

[Direct printer backend](../architecture/direct-printer.md) · [Video delivery](../video-delivery.md) · [Vault home](../index.md)

The requested experiment was a Bambu camera connection using only its IP and
per-printer access code, with JavaScript or WebAssembly in the browser. The
tested printer exposes **RTSPS**: RTSP carried over TLS, rather than RTMPS.
The existing approved Bambu profile uses port 322 and `/streaming/live/1`.

## Observations

These checks ran against the user's explicitly selected LAN printer and an
isolated browser fixture on 2026-10-25. No access code, private address or
credential-bearing stream URL belongs in the repository.

| Check | Result | What it establishes |
| --- | --- | --- |
| Native TLS/RTSP `OPTIONS` | TLS 1.3; `RTSP/1.0 200 OK` | The selected camera really speaks RTSPS. |
| Native FFprobe with the existing saved IP/code pair | Connected; H.264, 1920 × 1080 | The saved credentials and native camera connection work. |
| WebSocket upgrade on the camera's streaming path/port | `HTTP/1.0 405 Method Not Allowed` | This endpoint did not provide the WebSocket transport required by browser RTSP clients. |
| HTTPS tunnel preflight with `x-sessioncookie` | `HTTP/1.0 200 OK`; allows the origin, header and GET/POST/OPTIONS methods | The server recognizes HTTP tunneling and its preflight. |
| HTTPS tunnel GET with the session cookie and `Accept: application/x-rtsp-tunnelled` | `HTTP/1.0 200 OK`; `application/x-rtsp-tunnelled`; no `Access-Control-Allow-Origin` | An HTTP tunnel exists, but the actual streaming response does not grant browser cross-origin access. |
| Native system-CA certificate check when connecting by IP | Rejected with verification code 20 | The current test environment does not trust the printer's certificate chain. |
| Chromium and WebKit in a secure fixture with no restrictive app CSP | RTSP, RTSPS and RTMPS fetches rejected; video error 4 (`MEDIA_ERR_SRC_NOT_SUPPORTED`); those schemes rejected by the WebSocket constructor | Changing the app CSP or adding an access-code field cannot make the native browser APIs carry these protocols. |
| Same browser fixture | WASM instantiation succeeded; H.264-in-MP4 playback reported supported; `TCPSocket` and `UDPSocket` absent | The missing part is network transport, rather than a missing WASM runtime or H.264 playback support. |

The initial hand-written Digest authentication experiment received another 401;
the established native FFprobe client subsequently connected with the same saved
pair. That experimental client is not evidence of an invalid printer code.
The native probes made no configuration/control requests and did not change the
saved printer. FFprobe briefly opened media to identify the stream. Browser
checks contained no printer credentials. Desktop WebKit fixtures are not a
physical iPhone test.

The WebSocket result applies to the tested endpoint and firmware. It does not
rule out a future printer firmware exposing a documented browser transport.

## The printer's HTTPS tunnel

This is more promising than trying to add raw TCP to a web page. A conventional
JavaScript client could in principle use an HTTPS tunnel to exchange RTSP/RTP,
then remux H.264 into MP4 for the existing native video decoder. WASM software
decoding is not a prerequisite for this stream.

The tested firmware's tunnel still has two access requirements to resolve:
the browser must trust its certificate, and the actual tunnel responses must
provide the required CORS headers. A successful preflight alone is insufficient;
the GET response in this experiment omitted the allow-origin header. Neither
`no-cors` fetches nor a WASM module give application code readable stream bytes
in that situation. See the browser's
[CORS protocol](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).

No printer firmware, certificates, DNS, CORS policy or browser validation setting
was changed. The findings establish an inaccessible cross-origin tunnel on this
firmware, not a tested browser player over that tunnel. A firmware-provided,
trusted and correctly authorized tunnel would justify revisiting a custom
JavaScript transport without requiring a general socket API.

## Libraries reviewed

| Library | Browser-side work | Remaining transport requirement |
| --- | --- | --- |
| [Streamedian](https://streamedian.com/docs/) | JavaScript RTSP/RTP client; remuxes H.264/AAC into MP4 for native video through MSE | Its documentation requires a server-side WebSocket proxy. It also lists iOS Safari as unsupported. |
| [libmedia / AVPlayer](https://github.com/zhaohappy/libmedia/blob/master/site/docs/guide/player.en-US.md#rtsp-and-rtmp) | JavaScript/WASM media pipeline, with software decoding, hardware decoding and MSE options | Its RTSP/RTMP guide explicitly requires a WebSocket or WebTransport TCP proxy. The protocol URL examples do not mean a browser opens raw TCP. |
| [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/apps/website/docs/faq.md#is-rtsp-supported-by-ffmpegwasm) | FFmpeg compiled to WASM | The maintainers identify missing socket access as a barrier to RTSP support. Compiling a decoder does not grant new browser network APIs. |
| [Axis Media Stream Library JS](https://github.com/AxisCommunications/media-stream-library-js#streams) | JavaScript RTP-to-MP4 pipeline using the browser decoder | Expects bidirectional RTSP over WebSocket at the source or a proxy. The repository is archived. |
| [rtsp-relay](https://github.com/k-yle/rtsp-relay) | Browser JS-MPEG playback | Uses an Express server, FFmpeg and WebSockets. It is not a browser-only connection. |

No listed library was installed into the product: none supplies a direct path to
the tested printer from an ordinary website/PWA.

[Emscripten's networking guide](https://emscripten.org/docs/porting/networking.html)
explains the same boundary. Its browser socket compatibility uses WebSockets or
a native socket proxy; a WASM build does not create unrestricted native sockets.
WebTransport also needs a compatible server and is not a raw TCP adapter for an
existing RTSPS listener.

## Packaging alternatives

1. Keep the current Docker backend, which already owns Bambu authentication,
   camera transport and session recordings.
2. Explore packaging a local companion as a native service/executable without
   Docker. A bridge can forward/remux the already compatible H.264 stream for
   browser-native playback, rather than adding a phone-side software decoder.
   This is still a backend; it needs its own lifecycle and trusted browser
   connection, including HTTPS/origin policy for the hosted app.
3. Explore a native mobile wrapper with a native networking/media bridge. Its
   raw socket access would come from the installed app, not JavaScript/WASM
   inside the ordinary PWA. This is a separate distribution target.

[Chrome Direct Sockets](https://developer.chrome.com/docs/iwa/direct-sockets)
is a different installed-app path: it is restricted to Isolated Web Apps and
requires their permission/packaging model. Adding a PWA manifest or installing
LayerGlass to an iPhone home screen does not enable it. It is not a portable
replacement for the browser provider.

The resulting implementation decision is to keep direct Bambu RTSPS out of the
browser approval registry until an accessible browser transport is demonstrated.
This research does not select or implement a companion/wrapper, expose generic
streams, or change the working Direct and Docker providers.
