# Tutorial: Build your first schema pack

You'll fork the bundled `gbrain-base` pack, add a custom `researcher` page type, import a handful of placeholder researcher pages, backfill their `page.type` column with one command, then prove the wiring works by running `gbrain whoknows` and seeing your new type surface in results. End state: a forked-and-active pack on disk, ~5 pages typed as `researcher`, and a query that proves the pack-aware routing fires end-to-end.

**Want the WHY before the HOW?** Read [`what-schemas-unlock.md`](what-schemas-unlock.md) first — 7 concrete use cases (4000 invisible meetings, the founder ops brain, the research brain, the legal brain, the team brain, agent-as-co-curator) plus the structural argument for why types matter at query time. Then come back here for the 5-minute walkthrough.

The whole walkthrough takes about 5 minutes. You'll see something working by step 3.

## What you'll need

- gbrain v0.40.7.0 or later (`gbrain --version` to check)
- A brain that's been initialized (`gbrain init` already run; either PGLite or Postgres is fine)
- A terminal you can paste commands into

That's it. No API keys required for this tutorial — every step works against the bundled pack and local-only commands.

## Step 1: See what pack is active today

```bash
gbrain schema active --json
```

You'll see something like:

```json
{
  "pack_name": "gbrain-base",
  "version": "1.0.0",
  "sha8": "...",
  "page_types_count": 22,
  "source_tier": "default"
}
```

`source_tier: "default"` means you haven't customized anything — you're on the bundled pack. `page_types_count: 22` is the universal starter (person, company, meeting, note, etc.).

**You can't mutate bundled packs directly.** Step 2 forks it so you have something writable.

## Step 2: Fork the bundled pack

```bash
gbrain schema fork gbrain-base mine
```

Output: `Forked 'gbrain-base' → 'mine' at ~/.gbrain/schema-packs/mine/pack.json`.

The fork is a byte-for-byte copy of `gbrain-base` living at `~/.gbrain/schema-packs/mine/pack.json`. Now you have a writable pack you can mutate.

## Step 3: Activate the fork

```bash
gbrain schema use mine
```

Output: `Pack: mine (json) ... Active.`

Run `gbrain schema active --json` again to confirm `pack_name` is now `mine` and `source_tier` is `home-config` (read from `~/.gbrain/config.json`).

**You've already accomplished something visible** — the active pack changed, and any future query will route through your fork. The next four steps add a custom type and prove it works.

## Step 4: Add a researcher type

```bash
gbrain schema add-type researcher \
  --primitive entity \
  --prefix people/researchers/ \
  --extractable \
  --expert
```

Output: `Pack: mine (json)` + `Sha8: <prev> → <new>`.

What just happened:
- The mutation went through `withMutation`'s 8-step skeleton: bundled-guard → per-pack lock → read → mutate → file-plane lint validation → atomic write → audit log → cache invalidation.
- The pack now declares `researcher` as an entity primitive bound to `people/researchers/`, marked `extractable: true` (eligible for facts extraction) and `expert_routing: true` (surfaces in `whoknows` queries).
- An audit row landed in `~/.gbrain/audit/schema-mutations-YYYY-Www.jsonl` with your type name SHA-8-redacted and the prefix's first segment only (`people`) for privacy.

Verify the type is in the pack:

```bash
gbrain schema explain researcher
```

You'll see the resolved settings printed back.

## Step 5: Import some placeholder researcher pages

You need pages under `people/researchers/` for the next step to do anything. If your brain repo already has them, skip ahead. If not, drop 3-5 placeholder markdown files into `<your-brain-repo>/people/researchers/` and import:

```bash
mkdir -p people/researchers
cat > people/researchers/alice-example.md <<'EOF'
---
title: Alice Example
---

ML researcher at Example Lab. Works on contrastive embeddings.
EOF

cat > people/researchers/bob-example.md <<'EOF'
---
title: Bob Example
---

Vision researcher at Widget University. Recent paper on diffusion models.
EOF

cat > people/researchers/charlie-example.md <<'EOF'
---
title: Charlie Example
---

RL researcher at Acme Research. Focus on inverse reinforcement learning.
EOF

gbrain sync
```

The sync imports the new files. They'll be stored in the database but their `type` column will still be empty — the new type was added to the pack AFTER these pages already existed (the typical real-world scenario for an agent walking into an existing brain).

## Step 6: See the gap with `stats`

```bash
gbrain schema stats --json | jq '.aggregate, .dead_prefixes'
```

You'll see `untyped_pages: 3` (or however many you just imported) and `dead_prefixes: []` — your new prefix has 3 matching pages, so it's not dead.

The 3 researcher pages are "orphaned" by type even though they live in the right directory. The next step backfills them.

## Step 7: Backfill with `sync --apply`

First dry-run to see what would happen:

```bash
gbrain schema sync --json
```

You'll see something like:

```json
{
  "schema_version": 1,
  "apply": false,
  "per_prefix": [
    {
      "type": "researcher",
      "prefix": "people/researchers/",
      "would_apply": 3,
      "sample_slugs": ["people/researchers/alice-example", "people/researchers/bob-example", "people/researchers/charlie-example"],
      "applied": 0
    }
  ],
  "total_would_apply": 3,
  "total_applied": 0
}
```

`would_apply: 3` is what you'd touch. `sample_slugs` is the agent's drilldown signal — if those slugs look wrong, abort. They look right, so apply:

```bash
gbrain schema sync --apply
```

You'll see per-batch progress lines on stderr and a final `total_applied: 3`. The UPDATE ran in chunks of 1000 (yours fit in one chunk) and never wedged any concurrent writer.

## Step 8: Prove the wiring works

```bash
gbrain whoknows "machine learning"
```

If your researcher pages contain ML-related content, they'll surface in the ranked results — even though they're typed `researcher`, not `person` or `company`.

**This is the load-bearing demonstration of T1.5 wiring.** Pre-v0.40.7.0, `whoknows` hardcoded `['person', 'company']` as the eligible types and would have ignored your `researcher` pages entirely. The v0.40.7.0 wiring consults the active pack's `expert_routing: true` types via `expertTypesFromPack(pack.manifest)`, so your custom type now routes through expert search.

## What you built

You now have:
- A fork of `gbrain-base` named `mine` at `~/.gbrain/schema-packs/mine/pack.json`, active in your brain via `~/.gbrain/config.json`.
- A `researcher` page type registered in the pack with `entity` primitive, `people/researchers/` prefix, `extractable: true`, `expert_routing: true`.
- 3 pages typed as `researcher` (backfilled from disk via `gbrain schema sync --apply`).
- A query path that routes through the new type: `gbrain whoknows` reads the pack and includes `researcher` in its type filter.

You also exercised the full mutation skeleton: bundled-pack guard, per-pack lock, validation gate, atomic write, audit log, cache invalidation. Every step was idempotent — re-running any of them is a no-op.

## Next steps

**Add a link verb.** A `researcher` can `author` a `paper`. To model that:

```bash
gbrain schema add-type paper --primitive annotation --prefix research/papers/ --extractable
gbrain schema add-link-type authored --page-type researcher --target-type paper
gbrain schema graph
```

The graph now shows `researcher --(authored)--> paper`.

**Add aliases for query closure.** If you want `gbrain query researcher` to also surface `person` rows (because researchers ARE people):

```bash
gbrain schema add-alias researcher person
```

Read [`skills/conventions/schema-evolution.md`](../skills/conventions/schema-evolution.md) for the decision tree on when to add types vs aliases vs prefixes. The short version: <20 pages → don't pack-codify; 20-100 → alias on existing type; 100+ → first-class type.

**Lint your pack before shipping.** The 11-rule lint surface (with the optional `--with-db` flag for DB-aware checks) catches dangling references, prefix collisions, and dead-corpus warnings:

```bash
gbrain schema lint --with-db
```

**Commit your pack to source control.** If `~/.gbrain/schema-packs/mine/` is a git repo, commit `pack.json` and push. Your pack survives across machines, and the `mutation_count_anomaly` lint rule will nudge you when you hit >50 mutations in a week (the "you should be committing this" signal).

**For agents (MCP):** the same operations are reachable over HTTPS MCP via 9 new ops. Register an admin-scope OAuth client and `schema_apply_mutations` lets a remote agent compose multi-step refactors as one atomic batch. The batched MCP op + per-pack lock + audit log are the load-bearing primitives that make remote schema authoring safe. See [`skills/schema-author/SKILL.md`](../skills/schema-author/SKILL.md) for the agent dispatcher.

**Undo a mistake.** Every mutation primitive has an inverse (`remove-type`, `remove-alias`, `remove-prefix`, `remove-link-type`, `set-extractable false`, etc.). If you fork twice and want to revert, `gbrain schema downgrade` restores the previous active pack from `~/.gbrain/schema-pack-history.jsonl`.

## Related docs

- **Reference:** `gbrain schema --help` for the full 22-verb CLI surface; CLAUDE.md's "Schema Cathedral v3 (v0.40.7.0)" section for the module-by-module architecture.
- **How-to:** [`skills/schema-author/SKILL.md`](../skills/schema-author/SKILL.md) — the agent dispatcher with the 7-phase workflow (brain → assess → propose → apply → sync → verify → commit).
- **Explanation:** [`skills/conventions/schema-evolution.md`](../skills/conventions/schema-evolution.md) — when to add a type vs alias vs prefix.
- **Plan + decisions:** the original design captured 21 decisions including the bundled-pack guard rationale (D6), the empty-filter fallback contract (D4), and the MCP non-localOnly trust posture (D2). Lives in `~/.claude/plans/system-instruction-you-are-working-recursive-thacker.md` (private).
