# Personal GBrain 10-Star Setup

## Goal
Turn a working personal GBrain into a durable, high-signal operating brain:
fresh sources, healthy embeddings, populated graph and timeline layers,
running maintenance, deliberate cost controls, and a production path that is
only cut over after the local brain proves it is worth making durable.

This guide is for an operator's own brain. Keep private names, local paths,
keys, and receipts out of public docs; put those in the operator's private
handoff or session receipt.

## Senior Decision

Do not start with a database migration just because the word "production"
sounds serious.

The right order is:

1. **Make the local brain semantically alive.**
2. **Verify the maintenance loop.**
3. **Then decide whether the canonical brain should move to Postgres/Supabase.**

If the current brain has healthy embeddings but `0` links, `0` timeline
entries, stale sources, or no completed dream/autopilot cycle, moving it to
Postgres mostly makes an under-extracted brain more durable. Fix richness first.

## 10-Star End State

A personal GBrain is "10-star" when all of these are true:

1. **Routing is explicit**
   - `gbrain sources current --json` resolves the intended source for the
     current working directory or the operator deliberately uses federated
     search.
   - `gbrain sources list --json` shows every intended source exactly once,
     with correct `local_path`, `federated`, `page_count`, and `last_sync_at`.

2. **Embeddings are healthy**
   - `gbrain doctor --json` reports a healthy embedding provider.
   - `embedding_width_consistency` is healthy.
   - `gbrain stats` shows embedded chunk count equals total chunk count, unless
     embed-skip was intentionally applied to oversized or junk pages.

3. **The brain is not flat**
   - Links are populated.
   - Timeline entries are populated where the corpus contains dated events.
   - Entity link and timeline coverage are no longer `0%` unless the corpus is
     intentionally non-entity/non-event content.

4. **Sources are fresh**
   - No live source has `last_sync_at: null`.
   - `sync_freshness` is not failing.
   - A single consolidated sync command covers future sources. Use the
     approval-safe local-refresh form when source checkout pulls are not
     explicitly approved:
     ```bash
     gbrain sync --all --no-pull --parallel 4 --workers 4 --skip-failed
     ```
   - Use the remote-refresh form only when `git pull` inside each source
     checkout is intended:
     ```bash
     gbrain sync --all --parallel 4 --workers 4 --skip-failed
     ```

5. **The maintenance loop is running**
   - `gbrain autopilot --status` shows autopilot installed or running in the
     expected mode for the engine.
   - `cycle_freshness` is not failing for live sources, or every deferred source
     is documented as intentionally deferred.
   - Dream/autopilot phases have completed at least once for each live source
     that should produce synthesis, patterns, backlinks, extraction, or embed
     refreshes.

6. **Cost posture is deliberate**
   - `gbrain search modes` confirms the intended mode.
   - Use `conservative` while repairing a local brain or running high-volume
     maintenance.
   - Use `balanced` when the brain is useful enough for daily production work.
   - Use `tokenmax` only for explicit max-context sessions.

7. **Model routing is intentional**
   - `gbrain models` shows cheap utility work on a Haiku-class tier.
   - Default reasoning/chat and synthesis use a Sonnet-class tier unless the
     operator explicitly wants a deeper tier.
   - Opus-class or equivalent deep models are narrow, explicit, and not the
     default for routine maintenance.

8. **Content hygiene is actionable**
   - `frontmatter_integrity` issues are either fixed or assigned.
   - `content_sanity_audit_recent` events have an owner decision: accept,
     split, suppress, or repair the offending source.
   - No large recurring source is silently filling the brain with junk or
     embed-skipped pages.

9. **Production durability is chosen, not assumed**
   - PGLite remains acceptable for one-machine scratch and pilot work.
   - Postgres/Supabase becomes the canonical brain only when the operator needs
     multi-machine access, remote/shared MCP, larger corpus durability, or
     persistent workers.
   - The PGLite brain is preserved as fallback during cutover.

10. **Proof exists**
    - Final closeout includes `gbrain models`, `gbrain providers list`,
      `gbrain sources current --json`, `gbrain sources list --json`,
      `gbrain config show`, `gbrain doctor --json`, `gbrain stats`, and one
      real CLI or MCP search smoke test.
    - If the current working directory resolves to an empty `default` source,
      the smoke test must pass an explicit populated source with `--source`.
    - The closeout separates current state from recommended next state.

## Audit First

Run the full audit before setting a session goal:

```bash
git status --short --branch
gbrain models
gbrain providers list
gbrain sources current --json
gbrain sources list --json
gbrain config show
gbrain config get schema_pack
gbrain search modes
gbrain features --json
gbrain onboard --check --json
gbrain onboard --check --explain
gbrain autopilot --status
gbrain doctor --remediation-plan --json
gbrain doctor --json
gbrain stats
```

Read the results in this order:

1. **Branch and repo safety** — do not mutate a protected checkout.
2. **Routing truth** — `gbrain models`, `providers list`, `sources current/list`.
3. **Runtime truth** — engine, search mode, embeddings, schema pack, autopilot.
4. **Brain quality** — links, timeline, frontmatter, content sanity, cycles.
5. **Reachability** — `doctor --remediation-plan` may report a
   `max_reachable_score` below the target; do not chase an impossible number
   with repeated remediation loops.
6. **Schema-pack truth** — use `gbrain schema active` or the
   `get_active_schema_pack` operation for the resolved 7-tier active-pack
   truth. `config show` is file-plane readback; `config get schema_pack` is
   DB-plane readback. They may differ without meaning the active pack is
   broken. `onboard --check --explain` should agree with active-pack truth
   before you treat a pack migration as pending.
7. **Source freshness truth** — trust `sources status`, `sources list`, and
   doctor's `sync_freshness` check for sync decisions. Do not treat
   `BrainHealth.stale_pages` as filesystem drift; it is page/timeline
   freshness lag and can rise after a successful timeline backfill.
8. **Production decision** — only then decide whether to stay local or cut over.

## Execution Lane

### Phase 1 — Repair the live local brain

Use this when the brain is indexed and embedded, but flat or stale:

```bash
gbrain sync --all --no-pull --parallel 4 --workers 4 --skip-failed
gbrain extract links --source db
gbrain extract timeline --source db
gbrain extract timeline --from-page-dates --source db
gbrain extract all --source db
```

Omit `--no-pull` only when the operator has approved Git pulls in the
registered source checkouts. The default `sync --all` form can fast-forward
clean source repos before importing them.

Then rerun:

```bash
gbrain features --json
gbrain doctor --json
gbrain stats
```

Success means no live source is stale, links/timeline are no longer empty, and
doctor's graph/timeline recommendations have moved. If `sync_freshness` is
already OK, do not keep rerunning sync just because `get_health` reports
`stale_pages`; that counter means timeline rows are newer than the page row,
not that source files are stale on disk. The page-date pass is
explicit and conservative: it writes one structured timeline row per page only
when `effective_date_source` is non-fallback (`event_date`, `date`,
`published`, or `filename`), so sync timestamps do not become fake events. If
timeline remains empty after the DB-backed and page-date passes, try the
meeting-specific pass before declaring it intentionally absent:

```bash
gbrain extract timeline --from-meetings --source db --json
```

If that returns `pages_processed: 0`, the blocker is not a missed timeline
command. The indexed corpus has no typed meeting pages for that extractor to
walk; focus next on source cycles, corpus typing, and content hygiene instead
of repeatedly rerunning the same extraction. Current onboard checks suppress
the meeting-extraction auto-remediation in this state while keeping the
timeline warning visible.

### Phase 2 — Run source cycles deliberately

For every live source that should participate in synthesis and pattern
extraction:

```bash
gbrain dream --source <source-id> --json
```

Use `--dry-run --json` first when the source is new, large, or privacy-sensitive.
Do not use stale source ids. Validate them with:

```bash
gbrain sources current --source <source-id> --json
```

Treat dry-runs as readiness probes, not as proof that the source cycle is done.
Some dry-run phases can still write local DB receipts or proposal records, and
doctor's `cycle_freshness` check only clears after a real cycle completes.

Success means `cycle_freshness` no longer fails for live sources.

### Phase 3 — Fix content hygiene

Use doctor output to decide which repairs are safe:

```bash
gbrain frontmatter audit --json
gbrain frontmatter validate <source-path> --fix
gbrain sources audit <source-id>
```

Start with `frontmatter audit`, not broad strict validation. Broad
`frontmatter validate <source-path>` can report intentionally plain Markdown as
`MISSING_OPEN`; the audit command groups only the source-health issues that
doctor uses. Never bulk-fix another repo until the affected files and fix class
are known.

Treat content-sanity warnings as source-quality work, not as generic doctor
noise. If a source repeatedly produces junk or oversized pages, fix the source
pipeline before running more extraction over it.

Doctor's `content_sanity_audit_recent` check reads local audit JSONL files under
`${GBRAIN_AUDIT_DIR:-~/.gbrain/audit}`. That can include repeated historical
events from prior sync attempts. Separate current source state from audit
history before deciding the fix:

```bash
gbrain sources audit <source-id> --json --include-warns
python3 - <<'PY'
from pathlib import Path
import collections, json
events = []
for path in sorted((Path.home() / ".gbrain" / "audit").glob("content-sanity-*.jsonl")):
    events.extend(json.loads(line) for line in path.read_text().splitlines() if line.strip())
by_source = collections.Counter(ev.get("source_id") for ev in events)
by_type = collections.Counter(ev.get("event_type") for ev in events)
unique = {(ev.get("source_id"), ev.get("slug")) for ev in events}
print({"events": len(events), "unique_source_slugs": len(unique), "by_type": by_type, "by_source": by_source})
PY
```

If audit history is noisy but `sources audit` shows no current hard/soft blocks,
record the owner decision explicitly: accept large pages, split them, suppress
known generated artifacts, or repair the source pipeline. Do not treat repeated
historical warnings as proof that every source is currently broken.

If the current backlog is understood and accepted, acknowledge it instead of
deleting the audit trail:

```bash
gbrain doctor --acknowledge content_sanity_audit_recent
```

That stores the current high-water mark locally and lets doctor surface only
new content-sanity events after the acknowledgment.

For live DB truth, remember what the gate actually writes: soft-blocked pages
carry `frontmatter.embed_skip` and are excluded from embedding refreshes. A noisy
JSONL history with few or no live `embed_skip` pages is a different problem than
a brain currently full of non-embeddable pages. Do not delete audit history just
to make the dashboard green; fix or explicitly accept the live pages, then rerun
doctor and the search smoke.

### Phase 4 — Choose the cost posture

Stay on `conservative` while the brain is still being repaired. Move to
`balanced` only after the graph/timeline/cycle layers are useful:

```bash
gbrain config set search.mode balanced
gbrain search modes
```

Do not move to `tokenmax` as a default. It is a session-level choice for
expensive max-context work.

### Phase 5 — Cut over to production durability only after proof

If the operator needs shared or remote production use, follow the production
cutover guide after the local brain is healthy:

```bash
gbrain init --supabase
```

Then re-register sources, sync, embed, and prove parity before switching MCP
traffic. Keep the local PGLite brain available as fallback until the production
brain passes the acceptance gate.

## `/goal` Template

Set the session goal only after the audit above has run. A good goal is:

```text
Make the operator's personal GBrain 10-star: repair the live local brain first
by syncing every intended source, populating links and timeline, running
source cycles for every live source, fixing content/frontmatter blockers,
choosing the search-mode cost posture from live evidence, and only then cutting
over to Postgres/Supabase if production durability is still required; prove the
result with models, providers, sources, config, search modes, doctor, stats,
and a real CLI or MCP search smoke test.
```

Retune the goal only if the operator changes one of these:

- intended source set,
- cost posture,
- production engine target,
- privacy boundary,
- or acceptance gate.

## Acceptance Gate

Do not call the setup complete until all required evidence is fresh:

1. `git status --short --branch` is clean or residue is classified.
2. `gbrain sources list --json` shows the intended sources and no accidental
   stale source ids.
3. `gbrain config show` confirms the intended engine and embedding dimensions.
4. `gbrain search modes` confirms the chosen search mode.
5. `gbrain doctor --json` has no failing live-source freshness, cycle freshness,
   embedding, width, or routing checks.
6. `gbrain stats` shows nonzero links and timeline entries when the corpus
   supports them.
7. A real search smoke test succeeds:
   ```bash
   gbrain query "what should this brain help the operator remember?"
   ```
   If that returns no results because the current directory resolves to an
   empty `default` source, prove retrieval against a populated source instead:
   ```bash
   gbrain search "known corpus term" --source <source-id>
   ```
   Current CLIs print an empty-default routing hint for bare `gbrain search`
   when populated non-default sources exist; treat that hint as a routing fix,
   not as evidence that the indexed brain is empty.
8. If production cutover happened, an MCP or remote CLI smoke test succeeds
   against the production brain, not the fallback PGLite brain.

## Stop Conditions

Stop and ask before continuing when:

- a command would write to a protected repo or protected source,
- a source id in an automation does not exist in `gbrain sources list --json`,
- doctor remediation wants to run a protected/manual-only job,
- a cutover would require credentials, paid provider setup, or remote MCP/OAuth
  changes,
- or the only remaining failures are content/privacy decisions that require the
  operator's judgment.

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
