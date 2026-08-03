#!/usr/bin/env bash
# Exercise every /mesh-api/ endpoint the browser uses, against two HopReach
# instances that differ only in observation backend.
#
# The unit tests prove the translation layer produces the right shape from
# canonical types. This proves the backends actually fill those types on a
# real mesh — which is the half that unit tests with fake sources cannot
# reach, and where all four of the parity bugs were found.
#
# Usage: compare_mesh_api.sh http://localhost:9091 http://localhost:9092
set -uo pipefail

A="${1:?first HopReach base URL}"
B="${2:?second HopReach base URL}"
FAIL=0

say() { printf '%-34s %s\n' "$1" "$2"; }

check() { # name, jq-ish python expr, url path
  local name="$1" expr="$2" path="$3"
  local a b
  a=$(curl -s -m 30 "$A$path" | python3 -c "import json,sys; d=json.load(sys.stdin); print($expr)" 2>/dev/null)
  b=$(curl -s -m 30 "$B$path" | python3 -c "import json,sys; d=json.load(sys.stdin); print($expr)" 2>/dev/null)
  if [ -z "$a" ] || [ -z "$b" ]; then
    say "$name" "FAIL (a=${a:-<none>} b=${b:-<none>})"
    FAIL=1
    return
  fi
  say "$name" "a=$a b=$b"
}

echo "== which backend =="
say "source A" "$(curl -s -m 10 "$A/mesh-api/api/source")"
say "source B" "$(curl -s -m 10 "$B/mesh-api/api/source")"

echo
echo "== endpoints the browser calls =="
check "nodes: count"        "len(d['nodes'])"                       "/mesh-api/api/nodes?limit=5000"
check "nodes: with position" "sum(1 for n in d['nodes'] if n['lat'])" "/mesh-api/api/nodes?limit=5000"
check "nodes: never-heard null" "sum(1 for n in d['nodes'] if n['last_heard'] is None)" "/mesh-api/api/nodes?limit=5000"
check "scopes: count"       "len(d['byRegion'])"                    "/mesh-api/api/scope-stats"

# Packet window. The default is deliberately wide: only a backend ingesting
# live MQTT traffic has anything in the last hour, and a Beacon stood up from
# migrated data (tools/../cmd/corescope-to-beacon) has none — which reads as
# "the packets endpoint is broken on Beacon" when it is really "this instance
# has no traffic that recent". Override with WINDOW_HOURS to narrow it when
# both instances are genuinely live.
WINDOW_HOURS="${WINDOW_HOURS:-720}" # 30 days
SINCE=$(( ($(date +%s) - WINDOW_HOURS * 3600) * 1000 ))
UNTIL=$(( $(date +%s) * 1000 ))
W="/mesh-api/api/packets?since=$SINCE&until=$UNTIL&limit=200"
echo "   (packet window: last ${WINDOW_HOURS}h)"
check "packets: count"      "len(d['packets'])"                     "$W"
check "packets: with scope"  "sum(1 for p in d['packets'] if p.get('scope'))" "$W"
check "packets: with frame_bytes" "sum(1 for p in d['packets'] if p.get('frame_bytes'))" "$W"

# One packet's detail from EACH instance, using that instance's own packet.
# The two backends hold overlapping but not identical traffic, so asking B
# about a hash only A has tests nothing but the 404 path.
detail_of() { # base url -> "observations frame_bytes"
  local base="$1" hash
  hash=$(curl -s -m 30 "$base$W" | python3 -c "
import json,sys
ps=json.load(sys.stdin)['packets']
print(ps[0]['hash'] if ps else '')" 2>/dev/null)
  [ -z "$hash" ] && { echo "no-packets"; return; }
  curl -s -m 30 "$base/mesh-api/api/packets/$hash" | python3 -c "
import json,sys
d=json.load(sys.stdin)
p=d.get('packet',{})
print('obs=%d frame_bytes=%s scope=%r' % (
    len(d.get('observations',[])), p.get('frame_bytes'), p.get('scope','')))" 2>/dev/null \
    || echo "unreadable"
}
say "detail A" "$(detail_of "$A")"
say "detail B" "$(detail_of "$B")"

# Reach, for a node BOTH instances actually know about.
#
# This has to intersect the two node lists rather than take the first node
# from A. The backends observe overlapping but not identical meshes (a real
# run here: 480 shared, 48 CoreScope-only, 56 Beacon-only), so asking one of
# them about a node it has never seen tests the error path, not parity — and
# both correctly answer that with an error, which the comparison then reports
# as a failure of the reach endpoint itself.
curl -s -m 30 "$A/mesh-api/api/nodes?limit=5000" > /tmp/cmp-a.json 2>/dev/null
curl -s -m 30 "$B/mesh-api/api/nodes?limit=5000" > /tmp/cmp-b.json 2>/dev/null
PK=$(python3 -c "
import json
def keys(p):
    try:
        return {n['public_key'] for n in json.load(open(p))['nodes']}
    except Exception:
        return set()
both = sorted(keys('/tmp/cmp-a.json') & keys('/tmp/cmp-b.json'))
print(both[0] if both else '')" 2>/dev/null)
if [ -n "$PK" ]; then
  check "reach: links" "len(d['links'])" "/mesh-api/api/nodes/$PK/reach?days=7"
  check "reach: bidirectional" "sum(1 for l in d['links'] if l['bidir'])" "/mesh-api/api/nodes/$PK/reach?days=7"
  check "reach: both directions counted" "sum(1 for l in d['links'] if l['we_hear'] and l['they_hear'])" "/mesh-api/api/nodes/$PK/reach?days=7"
else
  say "reach" "SKIP (the two instances share no nodes)"
fi
rm -f /tmp/cmp-a.json /tmp/cmp-b.json

echo
if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: an endpoint returned nothing usable on one of the two backends."
  exit 1
fi
echo "OK: every endpoint answered on both backends."
