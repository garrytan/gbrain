# Production Brain, Balanced Cost

## Goal
Run the full production GBrain surface without paying frontier-model prices for every query. The canonical brain should be durable, agent-accessible, and easy to reason about, while the high-cost knobs stay opt-in.

## What the User Gets
Without this posture, the operator ends up with the worst mix: a fragile local runtime treated like production, retrieval settings that drift from intent, and surprise spend when the wrong model or mode gets used by default.

With this posture, the setup is boring in the right places:

- production brain on Postgres or Supabase
- PGLite reserved for scratch, recovery, or one-machine experiments
- explicit search-mode choice instead of silent defaults
- low-cost embeddings where possible
- stronger paid models only where they actually matter

## Recommended Posture

### Engine

- **Production:** `gbrain init --supabase` or another real Postgres target.
- **Scratch / recovery:** `gbrain init --pglite`.

Why: the repo's own install and topology docs treat Supabase/Postgres as the
production path for `1000+` files, multi-machine access, remote MCP, and
persistent workers.

### Search mode

- **Recommended production default:** `balanced`
- **Use `conservative`** when the operator is highly cost-sensitive or running
  large volumes of Haiku-class loops.
- **Use `tokenmax`** only when the operator explicitly wants max-context
  retrieval and accepts the cost.

Why: `balanced` is the Sonnet-tier sweet spot from
[`INSTALL_FOR_AGENTS.md`](../../INSTALL_FOR_AGENTS.md). It keeps expansion off,
raises the retrieval budget above `conservative`, and avoids the surprise-spend
shape of `tokenmax`.

### Model posture

- **Embeddings:** start with a healthy local embedding model if one already
  works. `ollama:bge-m3` at `1024` is a good middle lane when local throughput
  is acceptable and the schema matches.
- **Utility / expansion / cheap judgments:** Haiku-class.
- **Default chat / reasoning / synthesis:** Sonnet-class.
- **Deep-think / premium analysis:** Opus-class only when the task justifies it.

Why: the largest avoidable costs usually come from retrieval payload size and
chat-tier overuse, not from the Postgres engine itself. Keep the expensive tier
narrow.

### Remote access

- **Local single-agent use:** `gbrain serve` over stdio is fine.
- **Production remote/shared use:** `gbrain serve --http` on the production
  brain.

Why: remote/shared agent access is cleaner when the canonical brain lives on a
real Postgres-backed surface. OAuth works on both engines, but the durable
multi-agent lane belongs on Postgres/Supabase.

## Audit Before You Cut Over

Run these before changing anything:

```bash
git status --short --branch
gbrain models
gbrain providers list
gbrain sources list --json
gbrain sources current --json
gbrain config show
gbrain doctor --json
gbrain stats
```

Read them in this order:

1. **Routing truth:** `gbrain models`, `gbrain providers list`
2. **Source truth:** `gbrain sources list --json`, `gbrain sources current --json`
3. **Runtime truth:** `gbrain config show`, `gbrain doctor --json`, `gbrain stats`

Do not describe the target posture as if it is already live. If the current
brain is still `pglite` or still on `conservative`, say that plainly and keep
`current state` separate from `recommended state`.

## Cutover Plan

1. **Freeze the current local brain**
   - Keep the existing `~/.gbrain` state intact.
   - Treat it as the fallback and comparison surface, not as the future source
     of truth.

2. **Stand up the production brain on Postgres/Supabase**
   - Use `gbrain init --supabase`.
   - Keep this brain separate from the scratch PGLite brain.

3. **Confirm search mode with the operator**
   - Do not skip the search-mode prompt.
   - For the middle lane, recommend:
     ```bash
     gbrain config set search.mode balanced
     ```
   - Verify with:
     ```bash
     gbrain search modes
     ```

4. **Pin the model posture before bulk sync**
   - Verify the embedding model and dimensions first.
   - Do not switch between `768` and `1024`-dim embedding families casually.
   - After any model change, re-check `embedding_provider` and
     `embedding_width_consistency` in `gbrain doctor --json`.

5. **Register sources explicitly**
   - Add each source on purpose instead of assuming old local state will follow
     you automatically.
   - Use `gbrain sources list --json` after each add so the registry is
     auditable.

6. **Sync first, then fill the richer layers**
   - Start with content parity. When source checkout writes are not explicitly
     approved, use the approval-safe local-refresh form:
     ```bash
     gbrain sync --all --no-pull --parallel 4 --workers 4 --skip-failed
     ```
   - Use the remote-refresh form only when `git pull` inside each registered
     source checkout is intended:
     ```bash
     gbrain sync --all --parallel 4 --workers 4 --skip-failed
     ```
   - Then run the richer layers the operator actually wants:
     - `gbrain extract all`
     - `gbrain dream --source <id>` per stale source, or `gbrain autopilot`

7. **Switch agent traffic only after proof**
   - Point MCP / remote clients at the production brain only after the
     acceptance gate passes.
   - Leave the local PGLite brain available for scratch and recovery work.

## Recommended `/goal`

After the audit is done and the operator confirms the cost posture, a good goal
for the execution lane is:

```text
Cut over the production GBrain to Postgres/Supabase, set search.mode=balanced,
pin the embedding posture, re-register the intended sources, verify page/chunk
and search parity, run the richer layers needed for real production use, and
switch MCP traffic only after the acceptance gate passes.
```

Retune that goal only if one of these changes:

- the operator picks a different search mode or cost posture,
- the production engine target changes,
- the intended source set changes materially, or
- the acceptance gate proves the original objective is too vague to verify.

## Cost Levers That Actually Matter

1. **Search mode** is the first big lever.
   - `conservative` is cheapest.
   - `balanced` is the usual production value lane.
   - `tokenmax` is the expensive lane.

2. **Downstream chat tier** is the second big lever.
   - Keep Sonnet-class as the default.
   - Use Opus-class selectively.

3. **Hosted embeddings are optional.**
   - If local embeddings are healthy and acceptable in quality, keep them local
     first.
   - Pay for hosted embeddings only when recall quality or throughput is the
     real bottleneck.

4. **Expansion and premium probes should be opt-in.**
   - `balanced` and `conservative` keep expansion off by default.
   - Nightly eval and quality-probe loops should stay off until the operator
     wants them.

## Acceptance Gate

Do not call the cutover done until these are true:

1. `gbrain config show` or `gbrain search modes` confirms the chosen production
   search mode.
2. `gbrain sources list --json` on the production brain shows the intended
   source registry.
3. `gbrain stats` on the production brain shows page/chunk counts in the
   expected range relative to the source repos being migrated.
4. `gbrain doctor --json` shows:
   - healthy embedding provider
   - healthy embedding width consistency
   - no source that should be live but has never synced
5. A real MCP or CLI search smoke test succeeds against the production brain.
6. If you claim the richer product surface is live, links/timeline extraction is
   no longer silently `0` unless that layer was intentionally deferred.

## Tricky Spots

1. **"Full production" does not mean "turn every expensive knob on."** It means
   the durable architecture is in place and the paid surfaces are used on
   purpose.
2. **PGLite is a great scratch brain and a risky production brain** once the
   corpus gets large or remote/shared access matters.
3. **Search mode is not a footnote.** The cost spread is large enough that the
   operator must choose deliberately.
4. **Brain routing and source routing are separate.** A clean production DB with
   a messy source registry is still a messy operator experience.
5. **Model/schema drift is real.** If embeddings move from one dimension family
   to another, verify the schema before a long sync and before calling the
   system healthy.

## How to Verify

1. Confirm the production recommendation is explicit: Postgres/Supabase for the
   canonical brain, PGLite for scratch only.
2. Confirm the search-mode recommendation is explicit and does not silently
   accept defaults.
3. Confirm the cost posture names the real levers: search mode, model tier,
   hosted embeddings, and optional probe loops.
4. Confirm the cutover gate uses live CLI readback, not hand-wavy claims.
5. Before closeout, rerun the production-brain acceptance gate and
   `git status --short --branch`.

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
