# What schemas unlock

Most note-taking apps treat every page the same. You write something, it goes in a pile, you search the pile with text matching. Tags help, but tags are flat. After a few thousand pages, the pile gets noisy and the search gets stupid.

Schemas are how gbrain stops being a pile of notes and becomes something with structure. A schema declares what KINDS of things live in your brain (`person`, `company`, `meeting`, `researcher`, `case`, `lab-result`), what they link to (`attended`, `authored`, `prescribed-by`), what facts the system should extract automatically (`mrr=50000`, `damages=5000000`), and which types route through expert search vs general search.

The default schema (`gbrain-base`) ships with 22 page types covering the universal shapes — people, companies, meetings, notes, daily, calendar events. That's enough to start. But your brain is yours, and your brain's shape is not the default shape. A research brain needs `researcher` and `paper` as first-class types. A founder brain needs `lead`, `investor`, `portco`, `deal-stage`. A lawyer brain needs `case`, `motion`, `deposition`, `precedent`. Same engine, totally different shape.

v0.40.7.0 made it possible for AGENTS to author that shape for you. Not just "the user manually edits YAML in `~/.gbrain/schema-packs/mine/pack.yaml`" but "your agent sees the corpus, proposes a type, asks for approval, applies it atomically with a full audit trail, then backfills 4000 existing pages with one chunked SQL command." That's the new thing.

This doc is the WHY. The [tutorial](schema-author-tutorial.md) is the HOW.

## Killer use cases

### 1. The 4000 invisible pages

You have 4000 markdown files under `meetings/` going back two years. The default schema doesn't have a `meeting` type, so all 4000 are typed `note` (the catchall). When you run:

```bash
gbrain whoknows "Q3 roadmap discussion"
```

You get the top 10 text matches, ranked by raw relevance. The brain has no idea these are meetings. It can't route to attendees. It can't pull dates. It can't surface "this conversation came up again with the same people three weeks later."

Add a `meeting` type:

```bash
gbrain schema add-type meeting --primitive temporal --prefix meetings/ --extractable
gbrain schema sync --apply
```

The sync backfills `page.type = 'meeting'` on all 4000 pages in 1000-row batches. Now:

- `gbrain whoknows "Q3 roadmap discussion"` routes through the meeting type, ranking by `expert_routing` signal (attendees, recency, salience) instead of raw text.
- `gbrain extract-facts` runs on every meeting page automatically (because `extractable: true`), pulling typed facts like `attended_by=alice-example`, `date=2026-05-23`.
- The downstream `think` skill can now answer "what did we decide about pricing in the last three roadmap meetings" by querying the meeting graph instead of grep'ing 4000 files.

One command. 4000 pages went from invisible to queryable. The content didn't change. The structure did.

### 2. The founder ops brain

You're a founder or investor with ~500 markdown files mixing leads, portfolio companies, deal notes, intros, and follow-ups. You've been writing freely; you have no system. Your queries are all "wait, who introduced me to that fintech founder again?" and you scroll Notion for 20 minutes.

Add the founder shape:

```bash
gbrain schema fork gbrain-base mine
gbrain schema use mine

# Types
gbrain schema add-type lead       --primitive entity --prefix people/leads/         --expert
gbrain schema add-type investor   --primitive entity --prefix people/investors/     --expert --extractable
gbrain schema add-type portco     --primitive entity --prefix companies/portco/     --expert --extractable
gbrain schema add-type deal       --primitive entity --prefix companies/deals/      --extractable

# Link verbs
gbrain schema add-link-type invested-in --page-type investor --target-type portco
gbrain schema add-link-type intro-from  --page-type lead     --target-type lead
gbrain schema add-link-type passed-on   --page-type investor --target-type deal
gbrain schema add-link-type led-by      --page-type deal     --target-type investor

gbrain schema sync --apply
```

Now `gbrain whoknows "Series A SaaS"` routes through `investor` and `portco` types specifically, not the noisy general type set. `gbrain graph-query alice-example --type intro-from --depth 2` walks two hops of intros to surface "Alice introduced you to Bob who introduced you to Charlie." `gbrain extract-facts` starts producing typed claims from the fence in your deal pages: `(deals/acme-seed, raise=2000000, valuation=15000000, lead=widget-vc, closed_at=2026-05-23)`.

The CRM you've been promising yourself you'll set up next quarter? You just shipped it in 4 commands. It's downstream of your notes, not parallel to them.

### 3. The research brain

Replace "founder" with "PhD student" and the same pattern applies with different types: `researcher`, `paper`, `lab`, `grant`, `dataset` + `authored`, `cites`, `funded-by`, `uses-dataset`.

```bash
gbrain schema add-type paper --primitive annotation --prefix research/papers/ --extractable
gbrain schema add-link-type authored   --page-type researcher --target-type paper
gbrain schema add-link-type cites      --page-type paper      --target-type paper
gbrain schema add-link-type uses       --page-type paper      --target-type dataset
```

Suddenly "show me papers that cite this work AND use the same dataset" is a `gbrain graph-query` traversal, not 30 minutes in Google Scholar. The fact extraction picks up `arxiv_id=2402.04253`, `cited_by_count=140`, `published_date=2026-02-15` automatically. Your reading-list-as-markdown turns into a queryable research graph that knows who works on what and what's connected to what.

### 4. The legal brain (or any domain where claims have numbers)

Lawyers, medical providers, accountants, anyone working in a domain where the meaning of a number depends on its type. A "judgment of $5M" against a "$2M case strategy threshold" is a comparison the brain can do — but only if both numbers are typed.

```bash
gbrain schema add-type case --primitive entity --prefix legal/cases/ --extractable --expert
gbrain schema add-type motion --primitive annotation --prefix legal/motions/ --extractable
gbrain schema add-type deposition --primitive annotation --prefix legal/depositions/ --extractable
gbrain schema add-link-type filed-in --page-type motion --target-type case
gbrain schema add-link-type cites    --page-type motion --target-type precedent
```

Now `## Facts` fences in your case notes can carry typed claims (`damages=5000000`, `filed_date=2026-05-23`, `judge=jane-doe`) that gbrain stores as first-class columns. `gbrain eval trajectory legal/cases/acme-v-widget` prints the case history with regressions flagged. `gbrain founder scorecard` (renamed for legal: roll up plaintiff success rate, average damages, settlement-vs-trial ratio) gives you a structured view of how your practice is performing.

This isn't possible without typed page kinds. You can write the same prose in any note-taking app. Only gbrain treats the numbers as comparable across pages of the same type.

### 5. The team brain

`gbrain mounts add` lets you stack additional brains alongside your personal one. Each mounted brain has its OWN schema pack. The eng team's brain has `incident`, `runbook`, `service`, `oncall-rotation`. The design team's brain has `component`, `experiment`, `ab-test`, `figma-link`. The legal team's brain has cases and depositions.

When you query, the schema pack governs how each source's content is routed. An eng query against the mounted eng brain knows that `incidents/2026-05-23-db-outage.md` is an `incident` page with `severity=p0`, `mttr=47min`, `on_call=alice-example` — extractable typed facts. Your personal query against the same brain still works, but the routing is sharper because the eng team has invested in their ontology.

The schema is the team's tribal knowledge made explicit. Two engineers on different teams searching the same brain get DIFFERENT routing because their personal packs declare different expert types.

### 6. The "agent co-curates your ontology" pattern (the new thing)

This is what v0.40.7.0 actually enabled, and what the closed PR #1321 was reaching for.

Your OpenClaw (or any agent connected to your brain over HTTPS MCP with admin scope) watches your ingestion stream. After a week of you dumping notes under `garrytan/companies/yc-w24/`, the agent runs `gbrain schema detect` periodically, sees that prefix accumulating, and proposes:

> You have 47 pages under `companies/yc-w24/` typed as `company` (generic). They share a structural pattern (founder names, raise amounts, batch tag). Should I add a `yc-w24-company` type with `extractable: true` and the existing aliases pointing back to `company`? I'd backfill the 47 pages and add `cohort=W24` as a typed fact extracted from each page.

You approve once. The agent calls `schema_apply_mutations` over MCP with a batch:

```json
{
  "pack": "mine",
  "mutations": [
    {"op": "add_type", "name": "yc-w24-company", "primitive": "entity", "prefix": "companies/yc-w24/", "extractable": true, "expert_routing": true},
    {"op": "add_alias", "type": "yc-w24-company", "alias": "company"}
  ]
}
```

All inside ONE `withPackLock` scope, atomic, audited (the agent's `client_id` captured in the audit log as `actor: mcp:<clientId8>`). Cache invalidated cross-process. Sync backfills the 47 pages. The brain learned a new category of thing without you having to think about it.

The next time you query "YC W24 companies in fintech", the brain routes through the new type. Six months later when you forget the pattern entirely, the agent reminds you it's there and offers to consolidate it with the W25 batch.

The brain learns. The agent is the curator. You approve, the agent does the work.

### 7. The before-vs-after benchmark

If you want to FEEL the difference without buying the pitch:

Pick a real corpus you have. Run `gbrain whoknows` on a topic that should match. Note the top-3 results.

Then run `gbrain schema review-orphans --limit 50 --json` and look at the untyped pages. If 10+ of them share an obvious prefix that should be a real type, add the type + sync.

Re-run the same `whoknows` query. Top-3 should shift, because the new type is now routing through expert ranking instead of being lumped into the catchall. The numerical delta IS the win. You can run a tutorial in 5 minutes; this experiment proves it matters on your actual content.

## Why this matters

Three things gbrain does that generic note systems can't:

**1. The brain knows the difference between a person and an idea.** Page-type matters at query time. `gbrain whoknows` only considers `expert_routing: true` types. `gbrain extract-facts` only runs on `extractable: true` types. `gbrain graph-query` walks declared link verbs. None of that works on a flat tag system because tags don't have semantics — they're labels. Types are first-class citizens with rules attached.

**2. Untyped content is invisible content.** If your meetings are typed as `note`, expert routing skips them, facts extraction ignores them, link inference doesn't fire. They exist on disk and they're indexed for text search, but the structural surfaces (whoknows, find_experts, recall, think) treat them as second-class. Adding a type isn't cosmetic; it's structural promotion.

**3. The schema is queryable AND mutable AND auditable.** You can ask the brain what its schema looks like (`gbrain schema graph`), evolve it through 14 atomic CLI verbs + 9 MCP ops with full lock + audit semantics, and recover from any mistake (every primitive has an inverse, plus `gbrain schema downgrade` restores the previous active pack). This isn't "vibes-based knowledge management." It's a production system with structural integrity guarantees.

## What changed in v0.40.7.0 specifically

v0.39.1.0 shipped the schema-pack engine. You could ALREADY fork the bundled pack and edit `pack.yaml` by hand. What you couldn't do was let an agent author it safely — there were no atomic file locks, no audit log, no MCP exposure, no pack-aware wiring in the query path. The cathedral was built but unreachable from the outside.

v0.40.7.0 closed those gaps:

- **`withMutation` skeleton** wraps every primitive in 8 ordered safety steps (bundled-guard → lock → read → mutate → validate → atomic write → audit → invalidate). The pack file on disk is never partial. Two concurrent agents can't race.
- **Per-pack `O_CREAT|O_EXCL` atomic lock** (not the TOCTOU `existsSync+writeFileSync` pattern from page-lock.ts — codex caught that during plan review). TTL refresh every 10s while a mutation runs; `--force` means "steal stale lock" not "skip locking."
- **Privacy-redacted audit log** at `~/.gbrain/audit/schema-mutations-YYYY-Www.jsonl`. Type names sha8-hashed, prefixes truncated to first segment only. A leaked screenshot of the audit can't reveal sensitive taxonomy like `personal/oncology/` or `legal/depositions/`.
- **9 new MCP ops** including the batched `schema_apply_mutations` (admin scope, NOT localOnly — your OpenClaw and any remote agent author packs over normal HTTPS MCP, with `client_id` captured as `actor: mcp:<clientId8>`).
- **T1.5 wiring** finally completes for `whoknows` and `find_experts`: a custom `researcher` type marked `--expert` now actually surfaces in query results. Pre-v0.40.7 it silently never matched because the query path read hardcoded `['person', 'company']`.
- **Cross-process invalidation** via stat-mtime TTL gate inside `loadActivePack`. Operator runs `gbrain schema add-type` from a terminal; the autopilot daemon picks up the new type within 1 second without a restart.

The cumulative effect: an agent can safely co-curate your ontology with a complete forensic trail. That's the new thing.

## Where to start

- **Want to see it work in 5 minutes?** Run the [tutorial](schema-author-tutorial.md). Forks the bundled pack, adds a researcher type, proves the wiring end-to-end.
- **Want the agent recipe?** Read [`skills/schema-author/SKILL.md`](../skills/schema-author/SKILL.md). 7-phase workflow agents follow when they detect a schema-evolution opportunity.
- **Want the rules of thumb?** Read [`skills/conventions/schema-evolution.md`](../skills/conventions/schema-evolution.md). Decision tree for when to add a type vs alias vs prefix. <20 pages don't pack-codify. 100+ pages need first-class types.
- **Want the architecture?** The "Schema Cathedral v3 (v0.40.7.0)" section in `CLAUDE.md` has the 14-bullet module-by-module breakdown, each citing the design decision and codex finding that motivated it.
- **Want to set up an agent that co-curates your brain?** Run `gbrain auth register-client my-agent --scopes admin` to mint an OAuth client your remote agent can use to call `schema_apply_mutations` over MCP. The agent then runs detect → suggest → apply on its own cadence and asks you to approve substantive changes.

The killer feature isn't "schemas." Personal knowledge systems have had schemas forever. The killer feature is that your AGENT can shape them safely on your behalf, with structural integrity guarantees that match what you'd expect from a database, not a notes app.

That's what we built. Try it on a corpus you actually have and the numbers go up.
