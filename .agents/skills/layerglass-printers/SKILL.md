---
name: layerglass-printers
description: Change Layerglass approved-printer discovery, manufacturer adapters, per-printer connection setup, identity or MQTT telemetry.
---

# Layerglass printers

Read [approved adapters](../../../docs/camera-adapters.md) before changing
admission, protocols or manufacturer support. Bambu-specific details belong in
[`providers/bambu/`](../../../providers/bambu/) and its
[protocol note](../../../docs/reference/bambu-telemetry.md).

- Discovery starts with approved camera ports, then races bounded identity checks.
  An open port or generic MQTT broker alone does not identify an approved printer.
  Keep MQTT identity work shared per host and camera-port evidence independent.
- Add manufacturers via provider capabilities and the explicit approval manifest;
  do not expose generic RTSP/HTTP transports as addable printers.
- Codes belong to printers, are saved by the server, and are forgotten with that
  printer. Do not send saved credentials to the browser or run authentication
  against a real printer from an automated fixture test.
- Prefer verified model, name and serial data. Avoid a specific model as a
  fallback. IP is the last identity fallback and is shown in selection/diagnostics,
  rather than duplicated throughout the player.
- Scans occur on startup and user requests, with bounded caching and exponential
  backoff. Progress belongs in active diagnostics; log only scan start/finish.
- Preserve partial MQTT reports and replay snapshots. A compact diagnostic view
  and complete, sanitized debug clipboard are different consumers. Raw payloads
  must not leak credentials or stream URLs.
- Telemetry is currently read-only. Do not add printer commands while changing
  discovery, statistics or connection setup.

Run the affected Python suites (`test_identification.py`, `test_discovery_cache.py`,
`test_providers.py`, `test_cameras.py` or telemetry/history suites). Use generated
telemetry for browser checks. See [testing](../../../docs/development/testing.md)
for the separation between fixtures and explicitly scoped LAN checks.
