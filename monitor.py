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
content — same fix as traces.py's _content_hash excluding itself), and
compute TWO independent hashes instead of one:

    schema_hash   the key structure, recursively, with every value
                  discarded. Adding, removing, or renaming a field
                  changes this. Growing an observation array does not.
    value_hash    the multiset of leaf values, with every key name
                  discarded. A field being renamed while holding the
                  exact same value does NOT change this.

The two are deliberately orthogonal — schema_hash never looks at
values, value_hash never looks at keys — so a field rename with an
unchanged value shows up as schema-only, not as "everything changed".
Without that split, a single content hash conflates two unrelated
events that need opposite reactions:

    the Worker's own ECB-alias fix just deployed by this same commit
    series: added a field. Same underlying data, new shape. A single
    hash calls that "changed", indistinguishable from ECB actually
    revising a rate. That's the mirror image of the Valtiokonttori
    failure this file was built to catch: there, classification moved
    while the shape stayed put; here, shape moves while data doesn't.
    Same false signal, opposite direction.

Comparing old vs. new on both axes gives four states, not two:

    neither changed         unchanged_runs += 1 — frozen, maybe.
                             Could be legitimately static (ECB-DFR) or
                             a frozen feed (DS 105's failure mode).
                             Telling those apart needs per-series
                             cadence knowledge this file doesn't have.
    only value changed      ordinary observation — new data point.
    only schema changed     upstream added/removed/renamed a field.
                             This is what BoF v3→v4, Hankeikkuna
                             v1→v2, and ECB's ICP→HICP all were.
    both changed            new shape AND new data in the same call —
                             rare, worth a look either way.

HTTP errors are logged separately and never touch either stored hash —
a transient failure must not masquerade as any of the four states.

An error also does not, by itself, mean the upstream is down. The
first real run found two canaries erroring (Fingrid EPP: 401,
Eduskunta: 403) and both looked identical to a broken upstream — but
both upstreams were fine; the canary routes were wrong (one pointed at
a specific hardcoded dataset, the other at a single hardcoded case
that may no longer exist). Same shape, opposite cause, and nothing
here told them apart. So every error additionally probes the proxy's
own index route (any recognized-or-not path — the Worker answers with
its help JSON either way per its own error handler). If the index
answers, the Worker is up and the canary's own route/params are what's
wrong (`likely_cause: "canary_route"`); if the index is also
unreachable, the whole proxy is down (`likely_cause: "proxy_down"`).
This is a hint, not a verdict — see `_proxy_reachable`'s docstring.

Every run is appended to monitor/log.ndjson (append-only audit trail).
Current per-canary state lives in monitor/state.json (overwritten each
run, small, diffable).
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ECB_BASE_URL = "https://aci-ecb-proxy.ruotsalainen-marko.workers.dev"
UA = {"User-Agent": "aci-ecb-proxy-monitor/0.1"}

HERE = Path(__file__).resolve().parent
STATE_FILE = HERE / "monitor" / "state.json"
LOG_FILE = HERE / "monitor" / "log.ndjson"


def _fingrid_epp_path() -> str:
    """Sliding 6h window, not a fixed timestamp.

    A fixed start/end freezes: every run after the window has fully
    passed would keep returning the same cached answer forever,
    reading as `unchanged` for the wrong reason (a frozen request, not
    a stable series) — the exact confusion this file exists to avoid
    causing, this time in its own canary's argument rather than the
    upstream's data.
    """
    now = datetime.now(timezone.utc)
    start = (now - timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ")
    end = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"/api?ds=192&start={start}&end={end}&size=5"


def _eduskunta_asia_path() -> str:
    # The value contains a literal "/" that MUST be percent-encoded
    # (%2F) — this is the same trap the ?votes= route taught: a raw
    # slash does not work. urllib.parse.quote's default `safe='/'`
    # would leave it unescaped, so safe='' is required here.
    asia = urllib.parse.quote("HE 101/2024", safe="")
    return f"/?asia={asia}"


# Eight canaries. Six live on aci-ecb-proxy, one per upstream family
# documented in README.md, using only routes given there as concrete
# worked examples — no invented series keys (Suomen Pankki is excluded
# for exactly that reason: no safe example key is given, and a wrong
# seriesName is a silent trap per the README's own warnings). Two live
# on the proxies that actually own that data: Fingrid's real datasets
# and Eduskunta's case search are NOT re-exposed as generic passthroughs
# on aci-ecb-proxy (its FINGRID-EPP and EDK-VNS82025 routes are each
# hardcoded to one specific dataset/case — that's what broke on the
# first run), and adding generic ?ds=/?asia= passthroughs here instead
# would just make this proxy a second, competing owner of the same
# upstream — the isolation this whole system relies on argues against
# that as strongly as it argues for twelve separate proxies in the
# first place. A canary that points at the wrong service is a worse
# bug than a canary that points at the right one in another repo.
#
# max_silence_hint is informational only (see module docstring) —
# not measured yet, not enforced.
CANARIES = [
    {"key": "eurostat-fi10y", "base": ECB_BASE_URL, "path": "/?series=FI10Y",
     "max_silence_hint": "monthly series — unmeasured"},
    {"key": "ecb-dfr", "base": ECB_BASE_URL, "path": "/?series=ECB-DFR",
     "max_silence_hint": "step series, changes only on ECB decision dates — long silence is normal"},
    {"key": "vk-debt-interest", "base": ECB_BASE_URL, "path": "/?series=VK-INTEREST",
     "max_silence_hint": "unmeasured"},
    {"key": "vk-budget-interest", "base": ECB_BASE_URL,
     "path": "/?series=VT-INTEREST&yearFrom=2024&yearTo=2026",
     "max_silence_hint": "unmeasured"},
    {"key": "fingrid-ds192", "base": "https://aci-fingrid-proxy.ruotsalainen-marko.workers.dev",
     "build_path": _fingrid_epp_path,
     "max_silence_hint": "should move within hours; sliding 6h window, never frozen"},
    {"key": "eduskunta-asia", "base": "https://aci-policy-proxy.ruotsalainen-marko.workers.dev",
     "build_path": _eduskunta_asia_path,
     "max_silence_hint": "single case's processing history — silence is normal for long stretches"},
]


def _strip_volatile(obj: Any) -> Any:
    """Remove every `fetched` key, at any depth. Recurses into dicts and lists."""
    if isinstance(obj, dict):
        return {k: _strip_volatile(v) for k, v in obj.items() if k != "fetched"}
    if isinstance(obj, list):
        return [_strip_volatile(v) for v in obj]
    return obj


def _schema(obj: Any) -> Any:
    """Key structure only, recursively — every value discarded.

    A list of dicts collapses to the UNION of keys seen across its
    elements, not its length or per-element values: an observation
    array growing from 12 rows to 13 is data movement, not a schema
    change, and must not look like one. A list of scalars or an empty
    list collapses to a fixed marker for the same reason.
    """
    if isinstance(obj, dict):
        return tuple(sorted((k, _schema(v)) for k, v in obj.items()))
    if isinstance(obj, list):
        if not obj:
            return "empty_list"
        if all(isinstance(x, dict) for x in obj):
            keys: dict[str, Any] = {}
            for x in obj:
                for k, v in x.items():
                    keys.setdefault(k, _schema(v))
            return ("list_of_dict", tuple(sorted(keys.items())))
        if all(isinstance(x, list) for x in obj):
            return ("list_of_list", _schema(obj[0]))
        return "list_of_scalar"
    return "scalar"


def _leaf_values(obj: Any, out: list) -> None:
    """Every leaf value, key names discarded — the mirror of _schema."""
    if isinstance(obj, dict):
        for v in obj.values():
            _leaf_values(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _leaf_values(v, out)
    else:
        out.append(obj)


def content_hashes(raw: bytes) -> tuple[str | None, str | None, bool]:
    """(schema_hash, value_hash, was_json) — both sha256[:12], not cryptographic.

    The goal is detecting a difference, not preventing forgery. If the
    body isn't valid JSON, both hashes fall back to the same raw-bytes
    hash (there's no structure to split) and was_json is False.
    `fetched` is stripped before value_hash only — it's a key like any
    other for schema purposes (its presence is stable; only its value
    churns), but as a value it would defeat value_hash by changing on
    every single call regardless of the actual data.
    """
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        h = hashlib.sha256(raw).hexdigest()[:12]
        return h, h, False

    schema_canonical = repr(_schema(parsed))
    schema_hash = hashlib.sha256(schema_canonical.encode("utf-8")).hexdigest()[:12]

    leaves: list = []
    _leaf_values(_strip_volatile(parsed), leaves)
    value_canonical = json.dumps(sorted(leaves, key=lambda x: (str(type(x)), str(x))),
                                  ensure_ascii=False)
    value_hash = hashlib.sha256(value_canonical.encode("utf-8")).hexdigest()[:12]

    return schema_hash, value_hash, True


def _get(url: str) -> tuple[int | None, bytes]:
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # network failure, timeout, DNS — genuinely unreachable
        return None, str(e).encode("utf-8")


def _proxy_reachable(base: str) -> bool:
    """Probe the HOST a canary lives on, independent of that canary's
    own path being correct.

    Deliberately does NOT require any particular response shape or
    status code — canaries now live on three different Workers
    (aci-ecb-proxy, aci-fingrid-proxy, aci-policy-proxy), each with its
    own routing (aci-ecb-proxy answers unknown queries at `/` with a
    JSON help body; aci-fingrid-proxy's real routes are under `/api`,
    a fact learned the hard way for the canary path itself and not
    worth re-assuming for a probe path too). Any HTTP response at all —
    200, 400, 404, whatever — means the Worker is up and answering;
    only a None status (DNS failure, timeout, connection refused) means
    the host itself is down. This is intentionally the weakest possible
    check for exactly that reason: it needs no knowledge of any proxy's
    internal routes, so it can't itself become another guessed path.

    This is a hint for `likely_cause`, not a verdict: the host
    responding to HTTP doesn't prove a given canary's specific route or
    its upstream call would succeed, only that the failure isn't "the
    whole service is down". Telling "this route is wrong" apart from
    "this route is right but its own upstream is down" needs knowing
    the route is correct in the first place — exactly the fact that was
    missing for fingrid-epp and eduskunta-vns8 before this fix.
    """
    status, _ = _get(base + "/__monitor_reachability_probe__")
    return status is not None


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
    reachable_cache: dict[str, bool] = {}  # per host, at most one probe each per run

    for c in CANARIES:
        key = c["key"]
        base = c["base"]
        path = c["build_path"]() if "build_path" in c else c["path"]
        url = base + path
        status, raw = _get(url)
        prev = state.get(key)

        if status != 200:
            had_error = True
            if base not in reachable_cache:
                reachable_cache[base] = _proxy_reachable(base)
            likely_cause = "canary_route" if reachable_cache[base] else "proxy_down"
            entry = {"checked_at": now, "key": key, "event": "error",
                      "http_status": status, "detail": raw[:300].decode("utf-8", "replace"),
                      "likely_cause": likely_cause}
            log_lines.append(json.dumps(entry, ensure_ascii=False))
            # Deliberately do not touch state[key] — a transient failure
            # must not masquerade as "unchanged" (extends a silence streak
            # that didn't happen) or "changed" (there's nothing to compare).
            continue

        schema_hash, value_hash, was_json = content_hashes(raw)
        byte_length = len(raw)

        if prev:
            schema_same = prev.get("schema_hash") == schema_hash
            value_same = prev.get("value_hash") == value_hash
        else:
            schema_same = value_same = False

        if not prev:
            event = "first_seen"
        elif schema_same and value_same:
            event = "unchanged"
        elif schema_same and not value_same:
            event = "changed"
        elif not schema_same and value_same:
            event = "schema_changed"
        else:
            event = "changed_and_schema_changed"

        unchanged_runs = (prev.get("unchanged_runs", 0) + 1) if event == "unchanged" else 0
        first_seen = prev.get("first_seen", now) if prev else now

        state[key] = {
            "schema_hash": schema_hash,
            "value_hash": value_hash,
            "was_json": was_json,
            "byte_length": byte_length,
            "unchanged_runs": unchanged_runs,
            "first_seen": first_seen,
            "last_checked": now,
            "max_silence_hint": c["max_silence_hint"],
        }
        log_lines.append(json.dumps({
            "checked_at": now, "key": key, "event": event,
            "schema_hash": schema_hash, "value_hash": value_hash,
            "byte_length": byte_length, "unchanged_runs": unchanged_runs,
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
