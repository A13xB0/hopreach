# Running a local Beacon with a CoreScope mesh in it

What `docs/BEACON_COMPATIBILITY_PLAN.md` §0 was verified against. Keeping it
here means the comparison is repeatable rather than a claim about a machine
that no longer exists.

```bash
# 1. Database
docker run -d --name beacon-postgres \
  -e POSTGRES_USER=beacon -e POSTGRES_PASSWORD=beacon -e POSTGRES_DB=beacon \
  -p 5433:5432 postgres:16-alpine

# 2. Beacon itself (from a beacon-server checkout), pointed at beacon-config.yaml
#    here — Scotland IATAs, because that is the mesh being migrated in.
LISTEN_ADDR=:8090 \
POSTGRES_DSN="postgres://beacon:beacon@localhost:5433/beacon?sslmode=disable" \
CONFIG_PATH=/path/to/docs/beacon-local/beacon-config.yaml \
  go run ./cmd/beacon

# 3. Migrate a real CoreScope mesh in
go run ./cmd/corescope-to-beacon \
  -corescope https://scotmesh-corescope.mm7roq.compute.oarc.uk \
  -packet-hours 6 -packet-limit 1500 \
  | docker exec -i beacon-postgres psql -U beacon -d beacon -v ON_ERROR_STOP=1

# 4. Two HopReach configs differing only in source.type, then
python3 tools/compare_backends.py out-corescope out-beacon
bash tools/compare_mesh_api.sh http://localhost:9091 http://localhost:9092
```

Set `scope_observation.window_hours` to match `-packet-hours`, or the two
backends are answering the participation question over different windows and
the scope comparison is meaningless.

MQTT is not needed: the migration writes to Postgres directly, so Beacon's
ingest path stays idle and the data is whatever CoreScope had at that moment.
