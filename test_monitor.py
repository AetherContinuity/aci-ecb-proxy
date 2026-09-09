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
    monkeypatch.setattr(monitor, "CANARIES", [{"key": "x", "path": "/x", "max_silence_hint": "n/a"}])

    calls = iter([(200, json.dumps({"fetched": "t", "value": 1}).encode()),
                   (500, b"boom")])
    monkeypatch.setattr(monitor, "_get", lambda url: next(calls))

    monitor.run()
    state_after_success = monitor.load_state()
    assert state_after_success["x"]["unchanged_runs"] == 0
    saved_value_hash = state_after_success["x"]["value_hash"]
    saved_schema_hash = state_after_success["x"]["schema_hash"]

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
    monkeypatch.setattr(monitor, "CANARIES", [{"key": "x", "path": "/x", "max_silence_hint": "n/a"}])

    body = json.dumps({"fetched": "t1", "value": 1}).encode()
    body_same_value_new_fetch = json.dumps({"fetched": "t2", "value": 1}).encode()
    calls = iter([(200, body), (200, body_same_value_new_fetch), (200, body_same_value_new_fetch)])
    monkeypatch.setattr(monitor, "_get", lambda url: next(calls))

    monitor.run()
    assert monitor.load_state()["x"]["unchanged_runs"] == 0  # first_seen
    monitor.run()
    assert monitor.load_state()["x"]["unchanged_runs"] == 1
    monitor.run()
    assert monitor.load_state()["x"]["unchanged_runs"] == 2


def test_changed_value_resets_unchanged_runs(tmp_path, monkeypatch):
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES", [{"key": "x", "path": "/x", "max_silence_hint": "n/a"}])

    calls = iter([
        (200, json.dumps({"fetched": "t1", "value": 1}).encode()),
        (200, json.dumps({"fetched": "t2", "value": 1}).encode()),
        (200, json.dumps({"fetched": "t3", "value": 2}).encode()),
    ])
    monkeypatch.setattr(monitor, "_get", lambda url: next(calls))

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
    monkeypatch.setattr(monitor, "CANARIES", [{"key": "x", "path": "/x", "max_silence_hint": "n/a"}])

    calls = iter([
        (200, json.dumps({"fetched": "t1", "series": "ECB-DFR", "value": 1}).encode()),
        (200, json.dumps({"fetched": "t2", "alias": "ECB-DFR", "value": 1}).encode()),
    ])
    monkeypatch.setattr(monitor, "_get", lambda url: next(calls))

    monitor.run()
    monitor.run()

    log_lines = [json.loads(l) for l in (tmp_path / "log.ndjson").read_text(encoding="utf-8").strip().splitlines()]
    assert [l["event"] for l in log_lines] == ["first_seen", "schema_changed"]
    assert monitor.load_state()["x"]["unchanged_runs"] == 0


def test_both_hashes_changing_is_its_own_state(tmp_path, monkeypatch):
    monkeypatch.setattr(monitor, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(monitor, "LOG_FILE", tmp_path / "log.ndjson")
    monkeypatch.setattr(monitor, "CANARIES", [{"key": "x", "path": "/x", "max_silence_hint": "n/a"}])

    calls = iter([
        (200, json.dumps({"fetched": "t1", "series": "ECB-DFR", "value": 1}).encode()),
        (200, json.dumps({"fetched": "t2", "alias": "ECB-DFR", "value": 2}).encode()),
    ])
    monkeypatch.setattr(monitor, "_get", lambda url: next(calls))

    monitor.run()
    monitor.run()

    log_lines = [json.loads(l) for l in (tmp_path / "log.ndjson").read_text(encoding="utf-8").strip().splitlines()]
    assert [l["event"] for l in log_lines] == ["first_seen", "changed_and_schema_changed"]


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
