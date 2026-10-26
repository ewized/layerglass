---
title: Installation and configuration
tags: [operations]
---

# Installation and configuration

[Vault home](../index.md) · [Application guide](../reference/application-guide.md)

## Start from source

Install Docker Engine and Docker Compose on a machine that can reach the
printer's LAN. No Node or Python installation is needed on that host.

```sh
git clone https://github.com/ewized/layerglass.git
cd layerglass
cp .env.example .env
# Set DISCOVERY_CIDRS to your private printer subnet, for example 192.168.1.0/24.
docker compose up -d --build
```

Open `http://YOUR_SERVER_IP:8099`. Settings → Printers lists identified,
approved printers. Use the key icon to enter a printer's LAN code, then the
save/connect icon. The server remembers it for that printer. Forget removes
the saved printer/code until the next requested discovery finds it again.

The server scans at startup and on requested searches, with short caching and
backoff. Configure explicit private CIDRs when Docker's own bridge subnet is
not the printer subnet. Firewalls/VLAN routing must permit the approved camera
ports and the manufacturer's local identity/telemetry connection.

The supplied Compose file builds locally for the initial import. After a versioned
image has been published, choose `LAYERGLASS_VERSION` in `.env`, then run
`docker compose pull` followed by `docker compose up -d --no-build`. See
[release workflow](../development/ci-cd.md). An unpublished version cannot be pulled.

## Data and limits

Compose creates project-scoped `camera_data` and `camera_buffer` volumes.
`/data` contains known printers and LAN codes; treat backups accordingly.
`/buffer` contains temporary rewind history. The default retained-video target is
8192 MiB. Byte-budget trimming preserves each active camera's last available
fragment or frame, so this target can be exceeded; it is not a filesystem quota.
Sessions expire after 1800 seconds without a heartbeat. See `.env.example` and
the [configuration table](../reference/application-guide.md#environment-variables).

`docker compose down` preserves named volumes. Do not use `down --volumes` when
you intend to retain printer setup. The new project name uses separate volumes
from earlier prototype deployments; migrate data deliberately when upgrading one.

## HTTPS, phones and remote access

The app currently has no account system. Anyone able to reach it can view
cameras and manage printer setup. Use a trusted LAN or an authenticated reverse
proxy. HTTPS alone does not add authentication.

Terminate trusted HTTPS at your proxy and forward to port 8080 of the container
or the host's published port. The portable Compose file does not require a
particular proxy network or hostname. For Unraid, set `LAYERGLASS_URL` to the
desired viewer URL to customize its WebUI label.

Disable response buffering for `/api/events` and continuous `/replay/` responses;
allow long-lived connections and preserve streaming response headers. Do not
cache API/media responses. Cast receivers must also reach the HTTPS media URL
and trust its certificate. Optional Google Cast uses Google's sender SDK.

In iPhone Safari, open the HTTPS viewer and use Share → Add to Home Screen.
On Android, use the browser's Install app/Add to Home screen menu. PWA shell
caching is off by default (`PWA_CACHE_ENABLED=0`) so development reloads show
new files. [PWA behavior](../pwa.md) explains optional offline-shell caching.

## Routine operation

```sh
docker compose logs --tail=50
docker compose restart
docker compose down
```

If video cannot connect, check printer power, routing and that printer's LAN
code. Preserve `STREAM_MODE=copy` for compatible H.264; transcoding is an explicit
CPU cost. The server's `/healthz` is a process health check, not a promise that
every printer is online.
