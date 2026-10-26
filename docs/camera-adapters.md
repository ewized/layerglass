---
title: Approved printer adapters
tags: [technical]
---

# Approved printer adapters

The [Direct printer backend](architecture/direct-printer.md) has a separate,
browser-owned approval registry for identified **Klipper/Moonraker** firmware
controllers and their enabled same-origin MJPEG webcams. It is live only and
verified in Chromium; Safari/iPhone direct MJPEG is explicitly unavailable.
This does not add generic cameras to the Python server's approved port scanner.

[Vault home](index.md)

LayerGlass discovers camera services first, then races bounded manufacturer
identity checks. Only an approved printer model using its approved stream
profile enters the public catalog. Generic stream support is an internal
transport capability, not an option in Printers or a way to bypass approval.

Discovery stays on configured private IPv4 LANs, with at most 4096 addresses,
32 approved camera ports, 48 concurrent service probes, and 16 concurrent
identity checks. Scans run at startup and on request from Printers. They do not
recur through browser polling.

The manufacturer-independent server lives in `app.py`, `cameras.py`,
`discovery.py`, `identity.py`, and `replay.py`. The ESM player uses `printer-*`
web components. Manufacturer behavior lives under `apps/backend/providers/`; Bambu MQTT,
certificates, model data, announcements, and JPEG framing stay in `bambu/`.

## Current approval policy

`apps/backend/providers/approved-printers.json` lists approved manufacturers and, for each
stream protocol, its model codes, port, and path. The Bambu adapter currently
supports native JPEG on port 6000 for approved P1/A1 models and RTSPS on port
322 for approved X1/X2D/P2S/H2 models. Inventory entries without an approved
stream profile are ignored. Scan ports come exclusively from this file;
`DISCOVERY_PORTS` cannot add arbitrary ports.

An RTSP response or native TLS handshake creates only a candidate. For Bambu,
`identification.py` races MQTT/TLS on 8883 and camera TLS on the detected port.
Both require a CA-verified manufacturer serial mapped to an approved model.
MQTT additionally needs a CONNACK, including authentication refusal; it sends
no credentials, subscription, status request, or command. The first approved
identity wins without waiting for slow checks. Positive identity and host-wide
checks such as MQTT are shared per host. Camera TLS checks and negative results
are scoped to each port, so a failed control port cannot suppress discovery on
the camera port. In-flight work is bounded by the shared 16-worker pool and
discarded at the end of the scan.

Verified endpoint results are cached in memory for 20 seconds, with policy
validation repeated on cache use. Unresponsive or rejected endpoints use
15/30/60-second backoff across explicit scans, capped at 8,192 cache entries.
Known IPs run first. Name lookups use a separate 20-second cache, including
empty results; Bambu's bounded SSDP lookup listens for two seconds. No cache
timer initiates discovery or stores credentials. Unexpected scan-level errors
apply a 10–120-second exponential cooldown before another requested scan.

`POST /api/discover` returns queue/retry information and scan progress without
the raw `found` candidates. Public printer results come from the sanitized
`/api/cameras` catalog. Private candidates and their verified model/serial remain
available for admission and saved-pairing checks.

Only the winning model's approved camera protocol/port can be listed. A generic
broker, unverified certificate, SSDP name, open port, or generic video response
is insufficient. SSDP enriches a verified printer's name without overwriting
its verified model/serial. Unknown devices stay out of the catalog.

The RTSP and MJPEG helpers remain reusable by future approved adapters. They
do not grant generic RTSP/HTTP cameras registration, pairing, or playback.

## Adding a manufacturer

Implement `providers.base.StreamProvider`, register it in `PROVIDERS` in
`apps/backend/providers/__init__.py`, and explicitly add its supported models and stream
profiles to `approved-printers.json`. Registration alone grants no approval.
Use the internal RTSP/MJPEG transports when appropriate, or implement a new
bounded transport probe. Each admission check must validate model and profile.

| Member | Contract |
| --- | --- |
| `id` | Stable manufacturer adapter ID persisted with saved connections |
| `protocols` | New transport schemes and their default ports, if needed |
| `matches(item, source)` | Select an adapter from identity/source metadata; selection alone never grants approval |
| `identifiers(host, port, stop_event)` | Short, credential-free callables raced by the server; return verified provider/model/serial metadata or `None`; honor cancellation and fixed timeouts. Use `IdentityCheck(name, run)` for a shared host check or `IdentityCheck(name, run, per_port=True)` for camera-port evidence. Plain callables retain host-wide sharing. |
| `approved_stream(item)` | Require an approved model, protocol, and port; reject mismatches and unknown models |
| `accepts_source(source)` | Validate a saved URL against approved protocol, port, path, and authentication rules |
| `public(item)` | Sanitized provider/manufacturer/setup metadata and readable `model_name`; never include credentials or a private source URL |
| `probe(host, port, kind, tls, describe)` | For a new transport, return a bounded service candidate; this does not establish manufacturer identity |
| `identify(connection)` | Optional certificate hints; unverified hints cannot authorize admission |
| `discover_names(networks, targets, stop_event)` | Bounded friendly-name enrichment after independent identity validation |
| `configure(item, values, previous)` | Build a canonical approved URL pinned to the discovered endpoint; reject arbitrary stream settings |
| `create_relay(settings, relay_factory)` | Reuse FFmpeg or supply the start/close/status/restart lifecycle |
| `telemetry_supported` / `create_telemetry(...)` | Optional shared telemetry client; missing readings never interrupt video |
| `deduplicate_host` | Coalesce alternative profiles for one printer, if appropriate |

The current UI supports `{"type":"access_code"}`: a plaintext per-printer LAN
code entered inline and remembered on the server. There is no generic path,
username, or password editor. The configure API accepts only `access_code`.
A future approved manufacturer requiring different fields must deliberately
extend the setup contract, UI, and validation.

Friendly names take precedence over serials, then a short endpoint ID. IP/port
appears separately in printer selection and Stats for nerds. Printer telemetry
includes normalized readings plus an optional public `reported` tree of
manufacturer fields, independently of video. The quick panel selects useful
normalized readings; Copy debug info includes the entire public object and
nested arrays. Sanitize reports with `providers.telemetry.public_stats`
before exposing them. Keep raw transport messages and credentials private. See the
[Bambu implementation](reference/bambu-telemetry.md).

The player header uses the adapter's readable `model_name`, with the printer
serial on a smaller second line. If no serial is known, it uses the endpoint
ID. Friendly names remain in printer selection and diagnostics. Model names
come from the adapter's identity mapping without a default physical model.

## Compatibility and verification

Camera IDs still hash host, port, and transport. Settings version 3 retains
server-side access codes, identities, adapter IDs, forgotten entries and an
optional private `quarantined` map.
Approved saved sources with cached model identity resume immediately. Older
sources without identity wait for discovery. Legacy generic records remain
private and inactive, so upgrading does not delete stored credentials.

A verified serial is the saved code's printer binding. If discovery verifies a
different serial at that host, the server closes the old relay/telemetry clients
and makes the replacement require setup. The old source, serial/model identity
and adapter stay together in the private quarantine; they are never used to
authenticate the replacement or sent to the browser. The quarantine survives a
restart and prevents `STREAM_URL` from restoring the old pairing. Even if the
original printer returns, setup is explicit after a detected replacement.

Entering the replacement's code atomically replaces the quarantine with its new
pairing. Forgetting removes both the current candidate and its quarantined
binding. Setup also clears quarantined camera profiles for that same host;
unrelated printers retain their codes and clients. Repeated scans of the same
verified serial, name/firmware updates, and ordinary offline startup retain the
existing pairing.

If saving a quarantine fails, the running server still makes the endpoint
inactive while retaining the previous atomic settings file and the old code in
memory. A later explicit scan or successful setup/forget retries persistence.
Restarting before a successful save reloads the prior settings file.

`apps/backend/tests/test_identification.py` verifies MQTT responses, manufacturer/model
validation, concurrent races, per-host caching, and model/protocol admission.
`apps/backend/tests/test_providers.py` covers hidden generic candidates and legacy settings,
approved URL enforcement, explicit adapter approval, migration, and internal
transport reuse. `apps/web/tests/browser-providers.js` verifies the code-only printer
list and API rejection in Chromium and WebKit.
`apps/backend/tests/test_printer_bindings.py` covers verified replacements,
quarantine/reload/re-pair/forget, failed persistence, shutdown lock ownership,
late callbacks, different camera profiles and unchanged/legacy pairing.
