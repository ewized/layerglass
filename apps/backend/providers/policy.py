"""Explicitly supported printer models and their camera endpoints."""

import json
from pathlib import Path

APPROVED = json.loads(Path(__file__).with_name('approved-printers.json').read_text())


def approved_ports():
    return {profile['port']: kind for streams in APPROVED.values() for kind, profile in streams.items()}
