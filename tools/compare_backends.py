#!/usr/bin/env python3
"""Compare two HopReach pipeline runs that differ only in observation backend.

Pointing HopReach at CoreScope and at some unrelated Beacon proves nothing —
the maps would differ because the networks differ. This is meant to be run
after cmd/corescope-to-beacon has loaded the *same* mesh into Beacon, so any
remaining difference is HopReach's.

Equivalence deliberately is not byte-equality. Two differences are legitimate
and are reported as expected rather than as failures:

  * Timing. The runs happen minutes apart, so a repeater can cross the
    active/degraded threshold between them.
  * Per-hop confidence. Beacon reports whether a path hash resolved
    unambiguously and CoreScope does not, so Beacon can honestly say "unknown"
    where CoreScope names a node. Flattening that would be the bug.

Usage: compare_backends.py OUT_CORESCOPE OUT_BEACON
"""
import json
import sys
from pathlib import Path


def load(out_dir):
    p = Path(out_dir, "repeaters.geojson")
    if not p.exists():
        sys.exit(f"missing {p} — did that run finish?")
    data = json.loads(p.read_text())
    by_key = {}
    for f in data["features"]:
        props = f["properties"]
        by_key[props["public_key"].lower()] = {
            "name": props.get("name"),
            "lat": round(f["geometry"]["coordinates"][1], 6),
            "lon": round(f["geometry"]["coordinates"][0], 6),
            "status": props.get("status"),
            "default_scope": props.get("default_scope"),
            "observed_scopes": sorted(props.get("observed_scopes") or []),
            "observed_unscoped": props.get("observed_unscoped"),
        }
    return by_key


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    cs, bc = load(sys.argv[1]), load(sys.argv[2])

    failures, expected = [], []

    only_cs = sorted(set(cs) - set(bc))
    only_bc = sorted(set(bc) - set(cs))
    if only_cs:
        failures.append(f"{len(only_cs)} repeater(s) only in corescope: {only_cs[:5]}")
    if only_bc:
        failures.append(f"{len(only_bc)} repeater(s) only in beacon: {only_bc[:5]}")

    status_drift = 0
    scope_drift = []
    for key in sorted(set(cs) & set(bc)):
        a, b = cs[key], bc[key]

        # Position drives every raster. A disagreement here is not tolerable:
        # the two backends would be drawing different maps.
        if (a["lat"], a["lon"]) != (b["lat"], b["lon"]):
            failures.append(
                f"{key[:8]}: position {a['lat']},{a['lon']} vs {b['lat']},{b['lon']}")

        if a["name"] != b["name"]:
            failures.append(f"{key[:8]}: name {a['name']!r} vs {b['name']!r}")

        if a["default_scope"] != b["default_scope"]:
            failures.append(
                f"{key[:8]}: default_scope {a['default_scope']!r} vs {b['default_scope']!r}")

        # Observed scopes: CoreScope infers membership from decoded traffic,
        # Beacon reports it directly. They should agree on the set.
        if a["observed_scopes"] != b["observed_scopes"]:
            scope_drift.append((key[:8], a["observed_scopes"], b["observed_scopes"]))

        if a["status"] != b["status"]:
            status_drift += 1

    if status_drift:
        expected.append(
            f"{status_drift} repeater(s) changed activity status between runs "
            f"(the runs are minutes apart; the active threshold is hours)")

    print(f"repeaters: corescope={len(cs)} beacon={len(bc)} "
          f"shared={len(set(cs) & set(bc))}")

    if scope_drift:
        print(f"\nobserved-scope differences ({len(scope_drift)}):")
        for key, a, b in scope_drift[:10]:
            print(f"  {key}: corescope={a} beacon={b}")
        if len(scope_drift) > 10:
            print(f"  … and {len(scope_drift) - 10} more")

    for e in expected:
        print(f"\nEXPECTED: {e}")

    if failures:
        print(f"\nFAILURES ({len(failures)}):")
        for f in failures[:20]:
            print(f"  {f}")
        sys.exit(1)

    print("\nOK: both backends produced the same repeater set, positions, "
          "names and self-reported scopes.")
    if scope_drift:
        print("Observed scopes differ — see above; that is a real difference "
              "in what the two backends observed, not a formatting one.")


if __name__ == "__main__":
    main()
