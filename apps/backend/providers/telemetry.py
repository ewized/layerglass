"""Bounded public printer readings, including manufacturer-specific fields."""

import json
import math
import re


MAX_BYTES = 64 * 1024
MAX_NODES = 4096
MAX_DEPTH = 16
OMIT = object()
PRIVATE = re.compile(r'password|passwd|passphrase|accesscode|secret|token|credential|authorization|apikey')
URL = re.compile(r'\b[a-z][a-z\d+.-]*://[^\s]+', re.I)


def public_stats(value, secrets=(), *, max_bytes=MAX_BYTES, max_nodes=MAX_NODES):
    """Copy JSON readings without credentials, URLs, non-finite or huge values."""
    budget, nodes = max_bytes, max_nodes

    def visit(item, depth):
        nonlocal budget, nodes
        nodes -= 1
        if depth > MAX_DEPTH or nodes < 0 or budget < 4:
            return OMIT
        budget -= 4
        if isinstance(item, dict):
            result = {}
            for key, child in item.items():
                if not isinstance(key, str) or len(key) > 128:
                    continue
                if URL.search(key) or any(secret and secret in key for secret in secrets):
                    continue
                compact = re.sub(r'[^a-z0-9]', '', key.lower())
                if PRIVATE.search(compact) or compact in ('raw', 'private', 'username', 'pwd', 'auth', 'proto', 'prototype', 'constructor'):
                    continue
                size = len(json.dumps(key).encode()) + 1
                if budget < size:
                    break
                budget -= size
                clean = visit(child, depth + 1)
                if clean is not OMIT:
                    result[key] = clean
            return result
        if isinstance(item, list):
            result = []
            for child in item:
                clean = visit(child, depth + 1)
                if clean is OMIT:
                    break
                result.append(clean)
            return result
        if isinstance(item, str):
            item = item[:2048]
            for secret in secrets:
                if secret:
                    item = item.replace(secret, '[redacted]')
            item = URL.sub('[redacted]', item)
        elif isinstance(item, int) and not isinstance(item, bool):
            # JavaScript must not round large printer bitmasks or identifiers.
            item = str(item) if abs(item) > 2 ** 53 - 1 else item
        elif isinstance(item, float):
            if not math.isfinite(item):
                return OMIT
        elif item is not None and not isinstance(item, bool):
            return OMIT
        size = len(json.dumps(item, ensure_ascii=True).encode())
        if budget < size:
            return OMIT
        budget -= size
        return item

    result = visit(value, 0)
    return result if result is not OMIT else {}


def merge_report(previous, update):
    """Merge pushed object deltas; keyed hardware arrays retain omitted items."""
    if isinstance(previous, dict) and isinstance(update, dict):
        result = dict(previous)
        for key, value in update.items():
            result[key] = merge_report(previous.get(key), value)
        return result
    if isinstance(previous, list) and isinstance(update, list) and previous and update:
        for key in ('id', 'name', 'ams_id', 'tray_id', 'slot_id', 'index'):
            if all(isinstance(item, dict) and isinstance(item.get(key), (str, int)) for item in [*previous, *update]):
                result = list(previous)
                positions = {str(item[key]): index for index, item in enumerate(result)}
                for item in update:
                    index = positions.get(str(item[key]))
                    if index is None:
                        positions[str(item[key])] = len(result)
                        result.append(item)
                    else:
                        result[index] = merge_report(result[index], item)
                return result
    return update
