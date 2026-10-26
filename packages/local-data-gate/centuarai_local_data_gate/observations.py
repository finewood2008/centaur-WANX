"""Exact transmitted request observations shared by native and gateway adapters."""

from __future__ import annotations

from collections.abc import Mapping

from .protocol import DataProtocolError, validate_headers, validate_target

HEADER_NAMES = {
    "contentType": "content-type",
    "range": "range",
    "ifRange": "if-range",
    "ifMatch": "if-match",
    "lastEventId": "last-event-id",
    "agentId": "x-octop-agent-id",
    "dataContext": "x-wanx-data-context",
    "idempotencyKey": "idempotency-key",
    "webSocketKey": "sec-websocket-key",
    "webSocketProtocol": "sec-websocket-protocol",
    "spaceLink": "x-space-link",
    "contentSha256": "x-content-sha256",
}
_TRANSPORT = {
    "host",
    "connection",
    "upgrade",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "content-length",
    "accept",
    "accept-encoding",
    "accept-language",
    "user-agent",
    "cache-control",
    "pragma",
    "origin",
    "referer",
    "dnt",
}


def header_pairs(headers):
    items = list(headers.items()) if isinstance(headers, Mapping) else list(headers)
    result = []
    for key, value in items:
        key = key.decode("ascii") if isinstance(key, bytes) else key
        value = value.decode("ascii") if isinstance(value, bytes) else value
        if (
            not isinstance(key, str)
            or not isinstance(value, str)
            or not key.isascii()
            or not value.isascii()
            or any(ord(c) < 32 or ord(c) == 127 for c in key + value)
        ):
            raise DataProtocolError()
        result.append((key.lower(), value))
    if sum(len(k) + len(v) for k, v in result) > 32768:
        raise DataProtocolError()
    return result


def observed_headers(headers, *, proof_header=None):
    result = dict.fromkeys(HEADER_NAMES)
    names = {name: field for field, name in HEADER_NAMES.items()}
    seen = set()
    for key, value in header_pairs(headers):
        if key in seen and (key in names or key in {proof_header, "host", "content-length"}):
            raise DataProtocolError()
        seen.add(key)
        if key in names:
            result[names[key]] = value
        elif key not in _TRANSPORT and key != proof_header:
            raise DataProtocolError("LOCAL_DATA_FORBIDDEN")
    validate_headers(result)
    return result


def raw_target(scope):
    path = scope.get("raw_path")
    if path is None:
        path = scope["path"].encode("ascii")
    query = scope.get("query_string", b"")
    value = (path + (b"?" + query if query else b"")).decode("ascii")
    validate_target(value)
    return value


def one_header(headers, name):
    values = [value for key, value in header_pairs(headers) if key == name]
    if len(values) != 1 or not values[0]:
        raise DataProtocolError("LOCAL_DATA_REQUIRED")
    return values[0]
