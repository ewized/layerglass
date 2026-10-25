---
title: Product vision
tags: [product]
---

# Product vision

[Vault home](../index.md)

**A clear view of your print, on your own hardware.** Layerglass helps people
check a running 3D print from a phone or desktop without giving a cloud service
access to their camera or relying on a manufacturer's cloud connection.

The camera is the main interface. Opening the app should get a useful picture
on screen quickly. Scrubbing should feel immediate, and the printer information
beside a past frame should describe that moment. Diagnostics stay available
without crowding the normal viewing experience.

## Product boundaries

- Run on hardware the user controls, with the camera and telemetry relayed on their LAN.
- Support Bambu Lab in LAN-only mode first; add other manufacturers through
  identified, explicitly approved printer profiles.
- Prefer native video decoding, bounded storage and quiet network traffic for phones.
- Keep setup and discovery in the player settings; keep advanced diagnostics in
  the context menu.
- Treat camera monitoring as the core product. Small printer actions may support
  that experience later; full slicing and printer management are outside the current scope.

Today the app captures temporary rewind history for open viewer sessions.
It is not a permanent print recorder. The current web UI has no account system
and belongs on a trusted LAN or behind an authenticated proxy. Casting is
optional; Google Cast may load Google's sender SDK. Local viewing does not need it.

See [the roadmap](roadmap.md) for the distinction between shipped behavior and ideas.
