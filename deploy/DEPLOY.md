# confer-gbrain — production deploy runbook

> The prod brain (`brain-api.confersolutions.ai`, S1, Coolify app **108**
> `confer-gbrain-serve-http`) runs `ghcr.io/conferinc/gbrain:<tag>`. Coolify
> `build_pack=dockerimage` — it only **pulls** the tag; the image is built +
> pushed out-of-band. This runbook makes that reproducible. (Recipe reconstructed
> 2026-05-29 from the `sp1a-v10` docker history, which was the only record.)

## What the image is
Upstream gbrain (`bun install -g github:garrytan/gbrain#<ref>`) + a thin overlay
of Confer-patched TS source (`src/core/{operations,oauth-provider,migrate}.ts`) +
the `confer-everything-v1` schema pack. gbrain runs from TS source via Bun, so no
compile — overlaying .ts files is enough. `deploy/Dockerfile` is the recipe.

## Build a new image (on a linux/amd64 host — S1 works, it has docker + ghcr auth)

```bash
# 1. Get the code (the merged confer/main has the upstream fixes + our overlay)
git clone -b confer/main https://github.com/ConferInc/gbrain.git && cd gbrain

# 2. Stage the schema pack from confer-gstack into the build context root
cp /path/to/confer-gstack/confer-packs/confer-everything-v1/pack.yaml ./pack.yaml

# 3. Pin the upstream ref for reproducibility. As of 2026-05-29, upstream master
#    has the 4 reliability fixes (lock-renewal #1572, withRetry #1608, doctor
#    #1573, conversation-parser #1620). Pin to that commit:
UPSTREAM_REF=$(git ls-remote https://github.com/garrytan/gbrain master | cut -f1)

# 4. Build + push the next tag
docker build -f deploy/Dockerfile -t ghcr.io/conferinc/gbrain:sp1a-v11 \
  --build-arg UPSTREAM_REF="$UPSTREAM_REF" .
docker push ghcr.io/conferinc/gbrain:sp1a-v11
```

## Deploy with a CANARY (do NOT redeploy serve blind)

The brain is live. Validate the new image on a throwaway before touching serve:

```bash
# A. Smoke-test the new image against a SCRATCH DB (not prod) on the build host
docker run --rm -e DATABASE_URL="postgres://...scratch..." \
  ghcr.io/conferinc/gbrain:sp1a-v11 \
  sh -c 'gbrain init --url "$DATABASE_URL" --embedding-model openai:text-embedding-3-small --embedding-dimensions 1536 && gbrain doctor --json' | tail -20
# Expect: schema_version 110 (our migrations applied), doctor status ok/warnings.

# B. CANARY = the job worker (see WORKER section). Net-new resource: if the new
#    image is broken, the worker fails but the live serve (old image) is untouched.
#    Deploy the worker on sp1a-v11 first; confirm it processes a job. THAT
#    validates the image end-to-end.

# C. Only after the worker canary is healthy: bump Coolify app 108 to sp1a-v11.
#    docker exec coolify-db psql -U coolify -c \
#      "UPDATE applications SET docker_registry_image_tag='sp1a-v11' WHERE id=108;"
#    then redeploy app 108 via Coolify UI/API.

# D. Health-gate + rollback:
#    curl -fsS https://brain-api.confersolutions.ai/health   # expect {"status":"ok"}
#    rollback = set tag back to sp1a-v10 + redeploy (the old image is still in ghcr).
```

## Job worker (currently NOT deployed — ingest/re-embed/autopilot never run)

The serve container only ENQUEUES jobs; nothing drains `minion_jobs`. Stand up a
second Coolify resource from the SAME image + DATABASE_URL running the worker:

```
CMD: sh -c 'exec gbrain jobs supervisor'
```
Deploy this on the NEW image (sp1a-v11) first — it's the canary (step B). It must
have the lock-renewal fix (#1572, in upstream master) or it crashes ~39×/day on
DB blips; the pinned UPSTREAM_REF includes it.

## Coolify hardening on app 108 (GB-PROD findings)
- **Memory limit (DONE 2026-05-29):** applied as `custom_docker_run_options=--memory=2g --memory-swap=2g`
  on app 108 (the dedicated `limits_memory=2g` field is also set as belt-and-suspenders).
  Verified live: `HostConfig.Memory=2147483648`. The dedicated field alone proved
  unreliable on this `dockerimage` build pack — a container can get recreated without
  it — so the explicit run-option is the source of truth.
- **Healthcheck (`health_check_enabled=true`, `GET /health`):** Coolify auto-generates a
  `curl … || wget … || exit 1` probe. ⚠️ **The image MUST contain `curl`** — the base
  `oven/bun` image does not, so on an image without it the probe fails every tick and the
  container is flagged `unhealthy` (no crash-loop: Docker doesn't restart on unhealthy and
  Coolify has no restart-unhealthy scheduler, but it's a landmine). `deploy/Dockerfile` now
  `apt-get install`s curl — build + ship sp1a-v12 (or later) for the healthcheck to pass.
  Until then, keep `health_check_enabled=false` to avoid a false `unhealthy`, OR accept the
  cosmetic unhealthy on the curl-less image.
- A complex `--health-cmd` via `custom_docker_run_options` is **rejected** by Coolify's
  validator (422 "format is invalid"), so a bun-based probe can't be injected that way —
  curl-in-image is the supported path.
- The `&&`/`exec` CMD (already in deploy/Dockerfile) closes GB-PROD-5/8.

## Data durability (DONE 2026-05-29)
`/root/confer-brain-backup.sh` + daily 03:00 UTC cron on S1 dumps `confer_brain`
(pgvector container) to `/root/confer-brain-backups/` (14-day retention). First
dump verified (190 MB). Coolify's own backup only covers `coolify-db` metadata.

## RLS (0001) — gated, NOT active
`src/migrations/0001_confer_rls.sql` is intentionally not wired into the runner.
It's inert under the current `confer_brain_admin` (superuser/BYPASSRLS) role and
the `gbrain.allowed_sources` GUC is never set, so app-layer source scoping
(operations.ts) is the real isolation. Activating requires: a non-BYPASSRLS app
role + `SET LOCAL gbrain.allowed_sources` per request in serve-http + `WITH CHECK`
on the policies. Treat as a deliberate, separately-tested change.
