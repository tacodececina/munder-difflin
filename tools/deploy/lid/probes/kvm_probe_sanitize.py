#!/usr/bin/env python3
"""Shared sanitizers for LID inventory probes; never render cron arguments."""
from __future__ import annotations

import argparse
import os
import re
import shlex
import sys
import urllib.parse

IDENTIFIER = re.compile(r"^[A-Za-z0-9_.-]+$")
CRON_FIELD = re.compile(r"^[A-Za-z0-9*/?,#-]+$")
MACROS = {"@reboot", "@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"}


def safe_identifier(value: object) -> str | None:
    return value if isinstance(value, str) and IDENTIFIER.fullmatch(value) else None


def safe_schedule(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    if value in MACROS or re.fullmatch(r"every [0-9]+[smhd]", value):
        return value
    fields = value.split()
    return value if len(fields) == 5 and all(CRON_FIELD.fullmatch(field) for field in fields) else None


def cron_metadata(line: str, mode: str, source: str = "") -> str | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", stripped):
        return None
    try:
        fields = shlex.split(stripped, comments=True)
    except ValueError:
        return None
    macro = bool(fields and fields[0].startswith("@"))
    schedule_count = 1 if macro else 5
    user_count = 1 if mode == "system" else 0
    if len(fields) <= schedule_count + user_count:
        return None
    schedule = safe_schedule(" ".join(fields[:schedule_count]))
    if schedule is None:
        return None
    user = fields[schedule_count] if user_count else "root"
    if safe_identifier(user) is None:
        return None
    command = fields[schedule_count + user_count :]
    path = ""
    name = "unknown"
    target_host = ""
    for token in command:
        if "/push/" in token:
            path, name = "webhook-route", "opaque-push-endpoint"
            break
        if token.startswith(("http://", "https://")):
            host = (urllib.parse.urlsplit(token).hostname or "").lower()
            target_host = host if re.fullmatch(r"[a-z0-9.-]+", host) else ""
        api = re.search(r"/api/([A-Za-z0-9_.\/-]+)", token)
        if api:
            path, name = "api-route", api.group(1)
            break
        if token.startswith("/") and re.search(r"\.(?:sh|py|js|mjs|cjs)$", token):
            path, name = token, os.path.basename(token)
            break
    parts = ([source] if mode == "system" else []) + [schedule]
    if mode == "system":
        parts.append("user=" + user)
    parts.extend([path, name])
    if target_host:
        parts.append("targetHost=" + target_host)
    return "|".join(parts)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("root", "system"), required=True)
    parser.add_argument("--source", default="")
    args = parser.parse_args()
    for line in sys.stdin:
        rendered = cron_metadata(line, args.mode, args.source)
        if rendered is not None:
            print(rendered)


if __name__ == "__main__":
    main()
