---
title: Printer names and local MQTT telemetry
tags: [technical]
---

# Printer names and local MQTT telemetry

[Vault home](../index.md)

The server uses the Eclipse Paho Python client through `PrinterTelemetry` in
`telemetry.py`. Each configured printer using this adapter has one shared MQTT/TLS connection on
port 8883, using `bblp` and that printer's saved LAN access code. Browsers receive
sanitized telemetry through the existing SSE connection. Video delivery is
independent; unavailable MQTT does not interrupt the camera or its rewind buffer.

The wrapper subscribes only to `device/<serial>/report`. After subscription it
requests firmware information and one complete status snapshot. It then merges
pushed partial reports, preserving fields omitted by P1/A1-style delta messages.
Reconnects cannot request another full snapshot within five minutes. No print,
motion, heater, settings, or other printer-control commands are implemented.

Incoming reports are limited to 512 KiB. In addition to decoded readings, the
public `reported` object preserves all available manufacturer fields from
`print`, `info` and other report sections. Copy debug info preserves their keys,
including nested objects, AMS/tray arrays, sensors and module versions. The quick
Stats panel uses selected decoded readings with labels derived from their keys.
Object deltas preserve omitted fields. Hardware arrays are merged by
their reported `id`, `name`, `ams_id`, `tray_id`, `slot_id` or `index`, so updating
one nozzle or tray retains its siblings; an explicit empty list clears it.
Arrays without identities are replaced as a whole.

Shared filtering removes credential fields and stream URLs, redacts the saved
code if echoed in a value, rejects non-finite values and unsafe object keys, and
bounds the merged public snapshot. It keeps zero, false, null, unknown fields
and large IDs. Public copies are independent of the live merged state. No full
unfiltered MQTT messages or connection credentials are returned. Stats show
connection failures and stale reports, retaining the last known readings.

TLS verifies the bundled Bambu CA chain. Bambu certificates use their serial as
the certificate name. A Paho socket-open callback validates that identity before
MQTT CONNECT sends credentials; later connections must match the saved serial.
Certificate hostname checks against the IP are disabled, while CA verification
remains required. Python's strict key-usage check is relaxed for legacy BBL roots.
Forgetting a printer closes its telemetry connection and deletes its saved name,
identity, access code, and temporary video history.

Each startup/manual camera scan also listens for Bambu SSDP announcements for up
to six seconds, concurrently with port scanning. It listens on UDP 2021, 1900,
and 1990, and accepts names only from the configured LAN subnets with matching
Bambu service headers and sender/location addresses. Broadcasts enrich names;
they cannot replace the verified model/serial used for admission. Identity
is cached in the existing private printer store. Name changes update the player
and list without replacing the selected camera or its video buffer.

After a candidate camera service responds, `identification.py` races an anonymous
MQTT/TLS check against a camera TLS check, shared once per host per scan. Both
require a certificate verified by the bundled manufacturer CA and a serial
prefix matching a model in `../approved-printers.json`. The MQTT check also
requires a CONNACK response, including an authentication refusal. It sends no
username, password, subscriptions, report requests, or commands, and disconnects
immediately. Failed checks time out without retries. An unverified camera
certificate or an SSDP announcement alone cannot admit a printer.

The identity then selects the approved camera profile. Known RTSPS models'
port-6000 file/control tunnels are excluded from native JPEG results. Unknown
models and generic streams are omitted. Camera certificates that do not chain
to the bundled CA can still be identified through the verified MQTT service.
The X2D test case uses the confirmed 1920 × 1080 H.264 RTSPS feed.

SSDP broadcast/multicast commonly does not cross VLANs or Docker bridge
networks. If a friendly name is unavailable, the server uses the printer's
serial number as its display name. Until a serial is known, it uses a short
camera ID. The IP/port stays separate in printer selection and Stats for nerds;
model information remains in Stats for nerds.
Firmware/name metadata persists
across container recreation; live readings are held in memory.

## Research sources

- [OpenBambuAPI local MQTT reports and snapshot request](https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md)
- [Eclipse Paho Python client](https://eclipse.dev/paho/files/paho.mqtt.python/html/client.html), pinned to 2.1.0
- [Bambu Studio printer definitions](https://github.com/bambulab/BambuStudio/tree/master/resources/printers)
- [SSDP wire captures and fields](https://github.com/ClusterM/open-bamboo-networking/blob/master/research/06.01-ssdp.md)
- [Bambu certificate guidance](https://github.com/Doridian/OpenBambuAPI/blob/main/tls.md)

Verified on 2026-10-23 against a real Bambu Lab X2D, including anonymous MQTT
identification before pairing, MQTT TLS certificate validation, local MQTT
authentication, report subscription, and firmware/status
responses. Its routed subnet did not return friendly-name announcements, so
its display name defaults to its serial number. Automated fixtures additionally cover friendly
names, dynamic renaming, deltas, credential isolation, and unavailable telemetry.

Newer reports pack current temperature into the low 16 bits and target into the
high 16 bits of `device.extruder.info[].temp`, `device.bed.info.temp` and
`device.ctc.info.temp`. Extruder IDs, rather than array order or the legacy
active-nozzle reading, map ID 0 to Nozzle 1 and ID 1 to Nozzle 2. Partial reports
keep each nozzle's independent reading; invalid temperature sentinels stay
unknown. The low nibble of extruder state gives the count and the next nibble
identifies the active nozzle. Single-extruder printers keep their Nozzle row.
Fan readings prefer packed `fan_gear` bytes (0–255), with legacy 0–15 readings
as a fallback. Public values are percentages, and zero remains a valid reading.

Elapsed time uses a valid printer `gcode_start_time` timestamp when supplied.
Otherwise the server can observe a transition from IDLE/FINISH/FAILED into a
new PREPARE/RUNNING/PAUSE job. It includes preparation and pauses, holds at an
observed completion, and is sampled with the other readings for video replay.
Connecting halfway through a job without a start timestamp leaves its elapsed
time unknown. No start time is inferred from percent/remaining-time estimates,
page load or server startup. Clock state is temporary and can be lost on server
restart; reconnecting the existing telemetry client preserves it. Reported job
IDs are available in the native field tree and also help detect a new print.

Protocol references: Bambu Studio's
[extruder parsing](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceCore/DevExtruderSystem.cpp),
[chamber parsing](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceCore/DevChamber.cpp),
[fan parsing](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceCore/DevFan.cpp),
and [MQTT reports](https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md).
