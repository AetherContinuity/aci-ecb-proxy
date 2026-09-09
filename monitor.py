"""aci-ecb-proxy — canary monitor for silent upstream failure.

WHY THIS EXISTS
----------------
DS 105 (a different proxy) returned a constant zero for at least 180
days and nothing noticed. Separately, a Valtiokonttori guarantee series
had 23.3 bn EUR move from one category to another with no flag — the
total kept moving smoothly while the per-category history quietly
rewrote itself. Neither failure was a crash; both were silent.

This proxy is deliberately stateless (see README: "Haetut arvot eivät
kuulu muistiin; tämä rajapinta kuuluu" — fetched values don't belong in
memory, this interface does). So the monitor does NOT live inside the
Worker. It is a periodic outside caller — same shape as ogas3's monthly
snapshot: fetch, record, commit. Git is the database.

WHAT THIS DOES NOT DO
----------------------
It does not decide how much silence is too much. ECB-DFR is a policy
rate that is legitimately static for months; Fingrid EPP should move
every few minutes. A single "hasn't changed in N runs" rule would
either miss a frozen fast series or false-alarm on a genuinely stable
slow one — the same confusion this project spent all day untangling
elsewhere (missing vs. zero, unchanged vs. broken). So `max_silence_hint`
below is documentation, not an enforced threshold. Setting real
thresholds requires measuring each series' actual cadence first.

It does not parse each response for a semantic "did the number change"
signal either. That needs a per-route extractor (the response shapes
differ: {data:[...]}, {value, startTime}, {tila, ...}), and none of
this has been run against the live worker from this environment — the
sandbox this file was written in cannot reach *.workers.dev. Building
per-route parsers blind, untested, would be exactly the kind of
unmeasured code this project has been correcting all day. Left for a
later, separately-tested commit.

WHAT IT DOES DO
----------------
For each canary route: fetch, strip the proxy's own `fetched` timestamp
(present in every response; hashing it would hash the clock, not the
content — same fix as traces.py's _content_hash excluding itself),
hash what's left, and compare to the last recorded hash.

    same hash    unchanged_runs += 1, no alarm — could be a legitimately
                 static series (ECB-DFR) or a frozen one (DS 105's
                 failure mode). Distinguishing the two needs the
                 per-series cadence knowledge this file does not have.
    diff hash    unchanged_runs resets to 0, logged as a change.
    HTTP error   logged as an error. Does NOT touch the stored hash or
                 unchanged_runs — a transient failure must not look
                 like either "unchanged" or "changed".

Every run is appended to monitor/log.ndjson (append-only audit trail).
Current per-canary state lives in monitor/state.json (overwritten each
run, small, diffable).
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BASE_URL = "https://aci-ecb-proxy.ruotsalainen-marko.workers.dev"
UA = {"User-Agent": "aci-ecb-proxy-monitor/0.1"}

HERE = Path(__file__).resolve().parent
STATE_FILE = HERE / "monitor" / "state.json"
LOG_FILE = HERE / "monitor" / "log.ndjson"

# Six canaries, one per upstream family documented in README.md, using
# only routes given there as concrete worked examples — no invented
# series keys (Suomen Pankki is excluded for exactly that reason: no
# safe example key is given, and a wrong seriesName is a silent trap
# per the README's own warnings).
#
# max_silence_hint is informational only (see module docstring) —
# not measured yet, not enforced.
CANARIES = [
    {"key": "eurostat-fi10y", "path": "/?series=FI10Y",
     "max_silence_hint": "monthly series — unmeasured"},
    {"key": "ecb-dfr", "path": "/?series=ECB-DFR",
     "max_silence_hint": "step series, changes only on ECB decision dates — long silence is normal"},
    {"key": "vk-debt-interest", "path": "/?series=VK-INTEREST",
     "max_silence_hint": "unmeasured"},
    {"key": "vk-budget-interest", "path": "/?series=VT-INTEREST&yearFrom=2024&yearTo=2026",
     "max_silence_hint": "unmeasured"},
    {"key": "fingrid-epp", "path": "/?series=FINGRID-EPP",
     "max_silence_hint": "5 min cache TTL upstream — should move within hours"},
    {"key": "eduskunta-vns8", "path": "/?series=EDK-VNS82025",
     "max_silence_hint": "process tracking — silence is normal between sessions"},
]


def _strip_volatile(obj: Any) -> Any:
    """Remove every `fetched` key, at any depth. Recurses into dicts and lists."""
    if isinstance(obj, dict):
        return {k: _strip_volatile(v) for k, v in obj.items() if k != "fetched"}
    if isinstance(obj, list):
        return [_strip_volatile(v) for v in obj]
    return obj


def content_hash(raw: bytes) -> tuple[str, bool]:
    """sha256[:12] of the response with volatile fields stripped.

    Not cryptographic — the goal is detecting a difference, not
    preventing forgery. Falls back to hashing the raw bytes if the body
    isn't valid JSON, and reports that fallback via the second value.
    """
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return hashlib.sha256(raw).hexdigest()[:12], False
    canonical = json.dumps(_strip_volatile(parsed), sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12], True


def _get(url: str) -> tuple[int | None, bytes]:
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # network failure, timeout, DNS — genuinely unreachable
        return None, str(e).encode("utf-8")


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {}


def run() -> int:
    state = load_state()
    now = _now_iso()
    log_lines: list[str] = []
    had_error = False

    for c in CANARIES:
        key = c["key"]
        url = BASE_URL + c["path"]
        status, raw = _get(url)
        prev = state.get(key)

        if status != 200:
            had_error = True
            entry = {"checked_at": now, "key": key, "event": "error",
                      "http_status": status, "detail": raw[:300].decode("utf-8", "replace")}
            log_lines.append(json.dumps(entry, ensure_ascii=False))
            # Deliberately do not touch state[key] — a transient failure
            # must not masquerade as "unchanged" (extends a silence streak
            # that didn't happen) or "changed" (there's nothing to compare).
            continue

        h, was_json = content_hash(raw)
        byte_length = len(raw)

        if prev and prev.get("content_hash") == h:
            unchanged_runs = prev.get("unchanged_runs", 0) + 1
            event = "unchanged"
            first_seen = prev.get("first_seen", now)
        else:
            unchanged_runs = 0
            event = "changed" if prev else "first_seen"
            first_seen = now

        state[key] = {
            "content_hash": h,
            "was_json": was_json,
            "byte_length": byte_length,
            "unchanged_runs": unchanged_runs,
            "first_seen": first_seen,
            "last_checked": now,
            "max_silence_hint": c["max_silence_hint"],
        }
        log_lines.append(json.dumps({
            "checked_at": now, "key": key, "event": event,
            "content_hash": h, "byte_length": byte_length,
            "unchanged_runs": unchanged_runs,
        }, ensure_ascii=False))

    STATE_FILE.parent.mkdir(exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=1, sort_keys=True, ensure_ascii=False) + "\n",
                           encoding="utf-8")
    with LOG_FILE.open("a", encoding="utf-8") as f:
        for line in log_lines:
            f.write(line + "\n")

    for line in log_lines:
        print(line)

    # Errors are reported, not fatal — a canary being down right now is
    # itself the kind of thing this file exists to make visible over
    # time (via repeated "error" log lines), not to gate a build on.
    return 0


if __name__ == "__main__":
    sys.exit(run())
