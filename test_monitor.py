"""Tests for monitor.py — no network. Only the pure functions and the
state-transition logic are testable without hitting the live worker;
the fetch itself is verified by the first real GitHub Actions run,
same as ogas3's snapshot.py.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import monitor  # noqa: E402


def test_strip_volatile_removes_fetched_at_any_depth():
    obj = {"fetched": "2026-09-09T00:00:00Z", "data": [{"fetched": "x", "value": 1}]}
    stripped = monitor._strip_volatile(obj)
    assert "fetched" not in stripped
    assert "fetched" not in stripped["data"][0]
    assert stripped["data"][0]["value"] == 1


def test_value_hash_ignores_fetched_timestamp():
    a = json.dumps({"fetched": "2026-09-09T00:00:00Z", "value": 42}).encode()
    b = json.dumps({"fetched": "2026-09-09T06:00:00Z", "value": 42}).encode()
    _, va, _ = monitor.content_hashes(a)
    _, vb, _ = monitor.content_hashes(b)
    assert va == vb, "same content, different fetch time, must hash identically"


def test_hashes_stable_under_key_order():
    a = json.dumps({"b": 2, "a": 1}).encode()
    b = json.dumps({"a": 1, "b": 2}).encode()
    sa, va, _ = monitor.content_hashes(a)
    sb, vb, _ = monitor.content_hashes(b)
    assert sa == sb
    assert va == vb


def test_value_hash_changes_when_value_changes_schema_same():
    a = json.dumps({"fetched": "t", "value": 42}).encode()
    b = json.dumps({"fetched": "t", "value": 43}).encode()
    sa, va, _ = monitor.content_hashes(a)
    sb, vb, _ = monitor.content_hashes(b)
    assert sa == sb, "same keys, must not register as a schema change"
    assert va != vb


def test_schema_hash_changes_when_field_added_value_unchanged():
    a = json.dumps({"fetched": "t", "series": "ECB-DFR", "value": 1}).encode()
    # field renamed (series -> alias), value identical — the mirror-image
    # case this split exists for: same data, new shape.
    b = json.dumps({"fetched": "t", "alias": "ECB-DFR", "value": 1}).encode()
    sa, va, _ = monitor.content_hashes(a)
    sb, vb, _ = monitor.content_hashes(b)
    assert sa != sb, "key set changed, schema_hash must move"
    assert va == vb, "same multiset of leaf values, value_hash must NOT move"


def test_schema_hash_ignores_observation_array_growing():
    a = json.dumps({"fetched": "t", "data": [{"date": "2026-01", "value": 1}]}).encode()
    b = json.dumps({"fetched": "t", "data": [{"date": "2026-01", "value": 1},
                                              {"date": "2026-02", "value": 2}]}).encode()
    sa, _, _ = monitor.content_hashes(a)
    sb, _, _ = monitor.content_hashes(b)
    assert sa == sb, "a growing observation array is data movement, not a schema change"


def test_non_json_body_falls_back_to_raw_hash_and_flags_it():
    sh, vh, was_json = monitor.content_hashes(b"not json at all")
    assert was_json is False
    assert sh == vh
    assert len(sh) == 12


def test_error_does_not_touch_prior_state(tmp_path, monkeypatch):
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES", [{"key": "x", "base": "http://test", "path": "/x", "max_silence_hint": "n/a"}])

    first_run_calls = iter([(200, json.dumps({"fetched": "t", "value": 1}).encode(), False)])
    monkeypatch.setattr(monitor, "_get", lambda url, timeout=None: next(first_run_calls))
    monitor.run()
    state_after_success = monitor.load_state()
    assert state_after_success["x"]["unchanged_runs"] == 0
    saved_value_hash = state_after_success["x"]["value_hash"]
    saved_schema_hash = state_after_success["x"]["schema_hash"]

    def fake_get_erroring(url, timeout=None):
        if url.endswith("/x"):
            return 500, b"boom", False
        return 400, b'{"error":"Available series:"}', False  # reachability probe

    monkeypatch.setattr(monitor, "_get", fake_get_erroring)
    monitor.run()
    state_after_error = monitor.load_state()
    # error must leave the prior entry exactly as it was
    assert state_after_error["x"]["value_hash"] == saved_value_hash
    assert state_after_error["x"]["schema_hash"] == saved_schema_hash
    assert state_after_error["x"]["unchanged_runs"] == 0

    log_lines = (tmp_path / "log.ndjson").read_text(encoding="utf-8").strip().splitlines()
    assert json.loads(log_lines[0])["event"] == "first_seen"
    assert json.loads(log_lines[1])["event"] == "error"


def test_unchanged_runs_increments_across_identical_fetches(tmp_path, monkeypatch):
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES", [{"key": "x", "base": "http://test", "path": "/x", "max_silence_hint": "n/a"}])

    body = json.dumps({"fetched": "t1", "value": 1}).encode()
    body_same_value_new_fetch = json.dumps({"fetched": "t2", "value": 1}).encode()
    calls = iter([(200, body, False), (200, body_same_value_new_fetch, False),
                  (200, body_same_value_new_fetch, False)])
    monkeypatch.setattr(monitor, "_get", lambda url, timeout=None: next(calls))

    monitor.run()
    assert monitor.load_state()["x"]["unchanged_runs"] == 0  # first_seen
    monitor.run()
    assert monitor.load_state()["x"]["unchanged_runs"] == 1
    monitor.run()
    assert monitor.load_state()["x"]["unchanged_runs"] == 2


def test_changed_value_resets_unchanged_runs(tmp_path, monkeypatch):
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES", [{"key": "x", "base": "http://test", "path": "/x", "max_silence_hint": "n/a"}])

    calls = iter([
        (200, json.dumps({"fetched": "t1", "value": 1}).encode(), False),
        (200, json.dumps({"fetched": "t2", "value": 1}).encode(), False),
        (200, json.dumps({"fetched": "t3", "value": 2}).encode(), False),
    ])
    monkeypatch.setattr(monitor, "_get", lambda url, timeout=None: next(calls))

    monitor.run()
    monitor.run()
    assert monitor.load_state()["x"]["unchanged_runs"] == 1
    monitor.run()
    state = monitor.load_state()
    assert state["x"]["unchanged_runs"] == 0

    log_lines = [json.loads(l) for l in (tmp_path / "log.ndjson").read_text(encoding="utf-8").strip().splitlines()]
    assert [l["event"] for l in log_lines] == ["first_seen", "unchanged", "changed"]


def test_field_rename_with_same_value_logs_as_schema_changed_only(tmp_path, monkeypatch):
    """The exact case this split was built for: the Worker's ECB-alias fix
    renamed `series` to `alias` for the requested-name field. Same
    underlying value, new shape — must show up as schema_changed, not
    as an ordinary "changed" indistinguishable from ECB revising a rate.
    """
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES", [{"key": "x", "base": "http://test", "path": "/x", "max_silence_hint": "n/a"}])

    calls = iter([
        (200, json.dumps({"fetched": "t1", "series": "ECB-DFR", "value": 1}).encode(), False),
        (200, json.dumps({"fetched": "t2", "alias": "ECB-DFR", "value": 1}).encode(), False),
    ])
    monkeypatch.setattr(monitor, "_get", lambda url, timeout=None: next(calls))

    monitor.run()
    monitor.run()

    log_lines = [json.loads(l) for l in (tmp_path / "log.ndjson").read_text(encoding="utf-8").strip().splitlines()]
    assert [l["event"] for l in log_lines] == ["first_seen", "schema_changed"]
    assert monitor.load_state()["x"]["unchanged_runs"] == 0


def test_both_hashes_changing_is_its_own_state(tmp_path, monkeypatch):
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES", [{"key": "x", "base": "http://test", "path": "/x", "max_silence_hint": "n/a"}])

    calls = iter([
        (200, json.dumps({"fetched": "t1", "series": "ECB-DFR", "value": 1}).encode(), False),
        (200, json.dumps({"fetched": "t2", "alias": "ECB-DFR", "value": 2}).encode(), False),
    ])
    monkeypatch.setattr(monitor, "_get", lambda url, timeout=None: next(calls))

    monitor.run()
    monitor.run()

    log_lines = [json.loads(l) for l in (tmp_path / "log.ndjson").read_text(encoding="utf-8").strip().splitlines()]
    assert [l["event"] for l in log_lines] == ["first_seen", "changed_and_schema_changed"]


def test_error_blames_the_canary_route_on_a_fast_4xx(tmp_path, monkeypatch):
    """The real case: fingrid-epp (401) and eduskunta-vns8 (403) both
    errored on the first live run while both upstreams were actually
    fine — the canary routes were wrong (one hardcoded to a dead
    dataset, one to a single hardcoded case). A 4xx is unambiguous by
    HTTP's own convention: the proxy answered, so the fault is in what
    we asked for. No reachability probe needed to say so.
    """
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES", [{"key": "x", "base": "http://test", "path": "/x", "max_silence_hint": "n/a"}])

    probe_calls = {"n": 0}

    def fake_get(url, timeout=None):
        if url.endswith("/x"):
            return 401, json.dumps({"error": "unauthorized"}).encode(), False
        probe_calls["n"] += 1
        return 400, json.dumps({"error": "Available series:"}).encode(), False

    monkeypatch.setattr(monitor, "_get", fake_get)

    monitor.run()

    log_lines = [json.loads(l) for l in (tmp_path / "log.ndjson").read_text(encoding="utf-8").strip().splitlines()]
    assert log_lines[0]["event"] == "error"
    assert log_lines[0]["likely_cause"] == "canary_route"
    assert probe_calls["n"] == 0, "a concrete 4xx already answers the question; no probe needed"


def test_error_blames_upstream_on_a_fast_5xx(tmp_path, monkeypatch):
    """The second real entsoe incident: three calls at a 90s budget each
    got a 502 back in 5-17s -- fast, not a timeout, relaying ENTSO-E's
    own 527/599. The proxy answered coherently (so it isn't down and
    the request isn't retried, since a timeout retry can't fix an
    already-definitive status); the fault is upstream, not this
    canary's route.
    """
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES", [{"key": "x", "base": "http://test", "path": "/x", "max_silence_hint": "n/a"}])

    call_count = {"n": 0}

    def fake_get(url, timeout=None):
        call_count["n"] += 1
        return 502, json.dumps({"error": "bad gateway"}).encode(), False

    monkeypatch.setattr(monitor, "_get", fake_get)

    monitor.run()

    log_lines = [json.loads(l) for l in (tmp_path / "log.ndjson").read_text(encoding="utf-8").strip().splitlines()]
    assert log_lines[0]["event"] == "error"
    assert log_lines[0]["likely_cause"] == "upstream_error"
    assert "retried" not in log_lines[0]
    assert call_count["n"] == 1, "a fast 5xx is definitive -- it must not be retried"


def test_error_blames_the_proxy_when_index_is_also_unreachable(tmp_path, monkeypatch):
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES", [{"key": "x", "base": "http://test", "path": "/x", "max_silence_hint": "n/a"}])

    # Everything is unreachable, canary and reachability probe alike.
    monkeypatch.setattr(monitor, "_get", lambda url, timeout=None: (None, b"connection refused", False))

    monitor.run()

    log_lines = [json.loads(l) for l in (tmp_path / "log.ndjson").read_text(encoding="utf-8").strip().splitlines()]
    assert log_lines[0]["event"] == "error"
    assert log_lines[0]["likely_cause"] == "proxy_down"


def test_reachability_probe_runs_at_most_once_per_run(tmp_path, monkeypatch):
    """Two canaries that time out even after retrying (no status at all
    to go on) must not double-probe the index in the same run.
    """
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES", [
        {"key": "a", "base": "http://test", "path": "/a", "max_silence_hint": "n/a"},
        {"key": "b", "base": "http://test", "path": "/b", "max_silence_hint": "n/a"},
    ])

    probe_calls = {"n": 0}

    def fake_get(url, timeout=None):
        if url.endswith("/a") or url.endswith("/b"):
            return None, b"The read operation timed out", True
        probe_calls["n"] += 1
        return 400, b'{"error":"Available series:"}', False

    monkeypatch.setattr(monitor, "_get", fake_get)

    monitor.run()
    assert probe_calls["n"] == 1


def test_fingrid_path_uses_sliding_window_not_fixed_timestamps():
    """A fixed start/end would freeze once the window has fully passed,
    reading as unchanged for the wrong reason forever after. Two calls
    a moment apart must differ (end advances) but stay within the
    documented 6h span.
    """
    import re

    p1 = monitor._fingrid_epp_path()
    p2 = monitor._fingrid_epp_path()
    assert p1.startswith("/api?ds=192&start=")
    m = re.search(r"start=([^&]+)&end=([^&]+)&size=5", p1)
    assert m, p1
    start, end = m.group(1), m.group(2)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    from datetime import datetime as _dt
    delta = _dt.strptime(end, fmt) - _dt.strptime(start, fmt)
    assert delta.total_seconds() == 6 * 3600
    # not asserting p1 != p2: two calls in the same second are legitimately
    # identical. What matters is that the path is generated per-call from
    # the current time, not a baked-in literal.
    assert "start=" in p2 and "end=" in p2


def test_eduskunta_path_percent_encodes_the_slash():
    path = monitor._eduskunta_asia_path()
    assert path == "/?asia=HE%20101%2F2024"
    assert "/2024" not in path, "a raw slash in the value is the exact trap ?votes= already taught"


def test_canaries_route_to_six_distinct_hosts():
    bases = {c["base"] for c in monitor.CANARIES}
    assert bases == {
        "https://aci-ecb-proxy.ruotsalainen-marko.workers.dev",
        "https://aci-fingrid-proxy.ruotsalainen-marko.workers.dev",
        "https://aci-policy-proxy.ruotsalainen-marko.workers.dev",
        "https://aci-entsoe-proxy.ruotsalainen-marko.workers.dev",
        "https://aci-nve-proxy.ruotsalainen-marko.workers.dev",
        "https://aci-transmission-proxy.ruotsalainen-marko.workers.dev",
        "https://aci-pxweb-proxy.ruotsalainen-marko.workers.dev",
        "https://aci-amoc-proxy.ruotsalainen-marko.workers.dev",
        "https://aci-bem-proxy.ruotsalainen-marko.workers.dev",
        "https://aci-avoimuus-proxy.ruotsalainen-marko.workers.dev",
    }


def test_every_canary_has_exactly_one_way_to_get_a_path():
    for c in monitor.CANARIES:
        has_path = "path" in c
        has_build = "build_path" in c
        assert has_path != has_build, f"{c['key']}: needs exactly one of path/build_path"


def test_canary_keys_are_unique():
    keys = [c["key"] for c in monitor.CANARIES]
    assert len(keys) == len(set(keys))


def test_entsoe_path_uses_sliding_daily_window_not_fixed_timestamps():
    import re

    path = monitor._entsoe_day_ahead_path()
    assert path.startswith("/day-ahead-price?bzn=FI&periodStart=")
    m = re.search(r"periodStart=([^&]+)&periodEnd=([^&]+)$", path)
    assert m, path
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    from datetime import datetime as _dt
    start = _dt.strptime(m.group(1), fmt)
    end = _dt.strptime(m.group(2), fmt)
    assert (end - start).total_seconds() == 24 * 3600
    assert start.hour == 0 and start.minute == 0 and start.second == 0, \
        "window should be a full UTC calendar day, not an arbitrary trailing span"


def test_run_uses_build_path_when_present(tmp_path, monkeypatch):
    """fingrid-ds192 and eduskunta-asia have no static `path` at all —
    run() must call build_path() rather than KeyError on a missing key.
    """
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES", [
        {"key": "dynamic", "base": "http://test", "build_path": lambda: "/computed",
         "max_silence_hint": "n/a"},
    ])

    seen_urls = []

    def fake_get(url, timeout=None):
        seen_urls.append(url)
        return 200, json.dumps({"fetched": "t", "value": 1}).encode(), False

    monkeypatch.setattr(monitor, "_get", fake_get)
    monitor.run()
    assert seen_urls == ["http://test/computed"]


def test_get_distinguishes_read_timeout_from_other_failures(monkeypatch):
    """The real case: entsoe's day-ahead route timed out at 30s, 200 OK'd
    in 26.1s at 90s. That's a read timeout specifically -- not a DNS
    failure or connection refused, which also give status=None but
    aren't "slow", they're "absent" and retrying won't help either.
    """
    class FakeResponse:
        status = 200
        def read(self): return b"ok"
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def raises(exc):
        def _urlopen(req, timeout=None):
            raise exc
        return _urlopen

    monkeypatch.setattr(monitor.urllib.request, "urlopen", raises(TimeoutError("The read operation timed out")))
    status, raw, timed_out = monitor._get("http://test/x")
    assert status is None and timed_out is True

    monkeypatch.setattr(monitor.urllib.request, "urlopen",
                         raises(monitor.urllib.error.URLError(TimeoutError("timed out"))))
    status, raw, timed_out = monitor._get("http://test/x")
    assert status is None and timed_out is True

    monkeypatch.setattr(monitor.urllib.request, "urlopen",
                         raises(monitor.urllib.error.URLError(ConnectionRefusedError("refused"))))
    status, raw, timed_out = monitor._get("http://test/x")
    assert status is None and timed_out is False

    monkeypatch.setattr(monitor.urllib.request, "urlopen", lambda req, timeout=None: FakeResponse())
    status, raw, timed_out = monitor._get("http://test/x")
    assert status == 200 and timed_out is False


def test_timeout_retried_once_at_double_budget_and_success_is_not_an_error(tmp_path, monkeypatch):
    """The exact entsoe case: first attempt times out, retry at 2x
    succeeds. This must be treated as ordinary data -- classified into
    one of the four states, not logged as an error -- with
    upstream_slow noting the retry happened.
    """
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES",
                         [{"key": "x", "base": "http://test", "path": "/x", "max_silence_hint": "n/a"}])

    calls = []

    def fake_get(url, timeout=None):
        calls.append(timeout)
        if len(calls) == 1:
            return None, b"The read operation timed out", True
        return 200, json.dumps({"fetched": "t", "value": 1}).encode(), False

    monkeypatch.setattr(monitor, "_get", fake_get)
    monitor.run()

    assert calls == [monitor.DEFAULT_TIMEOUT, monitor.DEFAULT_TIMEOUT * 2], \
        "retry must use double the original timeout"

    log_lines = [json.loads(l) for l in (tmp_path / "log.ndjson").read_text(encoding="utf-8").strip().splitlines()]
    assert log_lines[0]["event"] == "first_seen"
    assert log_lines[0]["upstream_slow"] is True
    state = monitor.load_state()
    assert "x" in state, "the retried response's data must be saved like any successful run"


def test_timeout_retry_also_failing_is_still_an_error_marked_retried(tmp_path, monkeypatch):
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES",
                         [{"key": "x", "base": "http://test", "path": "/x", "max_silence_hint": "n/a"}])

    def fake_get(url, timeout=None):
        if url.endswith("/x"):
            return None, b"The read operation timed out", True
        return 400, b'{"error":"Available series:"}', False  # reachability probe

    monkeypatch.setattr(monitor, "_get", fake_get)
    monitor.run()

    log_lines = [json.loads(l) for l in (tmp_path / "log.ndjson").read_text(encoding="utf-8").strip().splitlines()]
    assert log_lines[0]["event"] == "error"
    assert log_lines[0]["retried"] is True
    assert log_lines[0]["likely_cause"] == "canary_route"
    assert "x" not in monitor.load_state()


def test_definitive_error_status_is_never_retried(tmp_path, monkeypatch):
    """A real 401/403/500 is a definitive answer -- doubling the timeout
    wouldn't change it, so it must not cost a second call.
    """
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES",
                         [{"key": "x", "base": "http://test", "path": "/x", "max_silence_hint": "n/a"}])

    call_count = {"n": 0}

    def fake_get(url, timeout=None):
        if url.endswith("/x"):
            call_count["n"] += 1
            return 401, b'{"error":"unauthorized"}', False
        return 400, b'{"error":"Available series:"}', False

    monkeypatch.setattr(monitor, "_get", fake_get)
    monitor.run()
    assert call_count["n"] == 1, "a definitive error status must not be retried"

    log_lines = [json.loads(l) for l in (tmp_path / "log.ndjson").read_text(encoding="utf-8").strip().splitlines()]
    assert "retried" not in log_lines[0]


def test_entsoe_has_a_raised_timeout_measured_live():
    entsoe = next(c for c in monitor.CANARIES if c["key"] == "entsoe-day-ahead")
    assert entsoe["timeout"] == 90, \
        "measured 26.1s live 2026-09-09; default 30s timed out on the first real run"


if __name__ == "__main__":
    import inspect

    tests = [(name, fn) for name, fn in list(globals().items())
              if name.startswith("test_") and inspect.isfunction(fn)]
    passed = 0
    for name, fn in tests:
        sig = inspect.signature(fn)
        kwargs = {}
        tmp_dir = None
        if "tmp_path" in sig.parameters:
            import shutil
            import tempfile
            tmp_dir = tempfile.mkdtemp()
            kwargs["tmp_path"] = Path(tmp_dir)
        if "monkeypatch" in sig.parameters:
            class _MP:
                def __init__(self):
                    self._saved = []

                def setattr(self, obj, name, value):
                    self._saved.append((obj, name, getattr(obj, name)))
                    setattr(obj, name, value)

                def undo(self):
                    for obj, name, value in reversed(self._saved):
                        setattr(obj, name, value)
            mp = _MP()
            kwargs["monkeypatch"] = mp
        else:
            mp = None
        try:
            fn(**kwargs)
            print(f"  PASS  {name}")
            passed += 1
        finally:
            if mp is not None:
                mp.undo()
            if tmp_dir is not None:
                shutil.rmtree(tmp_dir, ignore_errors=True)
    print(f"\n{passed}/{len(tests)} testiä läpi")
    sys.exit(0 if passed == len(tests) else 1)
