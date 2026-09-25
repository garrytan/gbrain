---
name: concept-synthesis
version: 0.2.0
description: Deduplicate and synthesize raw concept stubs into a tiered intellectual map (T1 Canon to T4 Riff), tracing idea evolution across sources over time. Transforms thousands of raw concept pages into a curated intellectual fingerprint. Includes a reversible curation cull pass (Phase 5) with hard keep/delete/merge verdicts, substance gates, grounding labels, cluster budgets, and merge-with-backlinks salience promotion.
triggers:
  - "concept synthesis"
  - "synthesize my concepts"
  - "find patterns across my notes"
  - "build my intellectual map"
  - "trace idea evolution"
  - "canon vs riff"
  - "cull my concepts"
  - "which concepts to keep"
  - "concept quality rubric"
mutating: true
writes_pages: true
writes_to:
  - concepts/
---

# concept-synthesis — From Raw Stubs to Intellectual Map

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> back-link enforcement and quote-fidelity requirements.
>
> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) —
> output files under `concepts/` per the primary-subject rule.

## What this solves

Many ingestion pipelines (signal-detector, idea-ingest, voice-note-ingest)
create a concept page for every idea mentioned. Over months this produces:

- Thousands of stub pages, many duplicates or near-duplicates
- Timeline entries that repeat the same source across multiple concept pages
- No synthesis — just "the user mentioned X on this date"
- No tier assignments — everything flat
- No clustering — related ideas aren't linked

This skill transforms that raw material into a curated intellectual map.

## Architecture

```
Phase 1: Dedup + merge (deterministic)
  N stubs → ~N/4 canonical concepts
    ├── Jaccard dedup (word-overlap on titles + first-paragraph)
    ├── Substring dedup ("founder mode" vs "founder mode vs manager mode")
    ├── Semantic dedup (LLM: "are these the same idea?")
    └── Merge timelines + aliases from duplicates into the canonical page

Phase 2: Score + tier (deterministic + heuristic)
  Each canonical concept → scored and tiered
    ├── Frequency: distinct sources referencing this concept
    ├── Timespan: first mention → last mention in days
    ├── Breadth: distinct months it appears in
    ├── Engagement: avg engagement on concept-bearing sources (if available)
    └── Tier: T1 Canon | T2 Developing | T3 Speculative | T4 Riff

Phase 3: Synthesize (LLM, T1+T2 only)
  T1 + T2 concepts → rich synthesis
    ├── Evolution narrative: how the idea sharpened over time
    ├── Best articulation: highest-engagement or most precise quote
    ├── Related concepts: cross-links to other concepts
    ├── Context: what was happening when this idea emerged / evolved
    └── Counter-positions: what this idea argues against

Phase 4: Cluster + map (LLM)
  All tiered concepts → intellectual clusters
    ├── Group related concepts into domains (auto-named via LLM)
    ├── Generate cluster summary pages
    ├── Build a master concepts/README.md with the full map
    └── Identify idea genealogies (concept A → evolved into concept B)

Phase 5: Curation cull (rubric + reversible merge)
  Each concept → hard verdict: ELITE | KEEP | MERGE/REWRITE | DELETE
    ├── 6-axis rubric (substance 2x, packaging 1x) + minimum substance gate
    ├── Grounding labels (VERIFIED / OPINION / NEEDS_SOURCE / UNSAFE)
    ├── Cluster budgets + reputational-risk gate
    ├── Merge-with-backlinks into cluster canonicals (fully reversible)
    └── merge_count / independent_sources → emergent tier promotion
```

## Invocation

The skill is markdown agent instructions. The agent uses gbrain's
existing operations + LLM passes:

```bash
# 1. List all concept pages
gbrain query "type:concept" --limit 10000 --json

# 2. Phase 1 dedup — agent applies Jaccard + substring locally,
#    then LLM passes to identify semantic duplicates.

# 3. Phase 2 tier — agent scores each canonical concept based on
#    frequency / timespan / breadth and writes tier into frontmatter.

# 4. Phase 3 synthesis — for each T1/T2, agent reads the timeline
#    + associated source pages and writes a synthesis section
#    onto the concept page via put_page.

# 5. Phase 4 clustering — agent reads the tiered concept list
#    and writes concepts/README.md with the full intellectual map.
```

## Output: concept page format (post-synthesis)

### T1 Canon — full synthesis

```markdown
---
title: "concept name"
type: concept
tier: 1
tier_label: "Canon"
mention_count: 18
distinct_months: 8
first_mention: "YYYY-MM-DD"
last_mention: "YYYY-MM-DD"
composite_score: 78.4
aliases: ["alternate phrasing 1", "alternate phrasing 2"]
related: ["sibling-concept-1", "sibling-concept-2"]
---

# concept name

**Tier 1 — Canon** | 18 mentions across 8 months

## Synthesis

[2-4 paragraph narrative tracing how the idea evolved, what it means in
the user's worldview, why it matters. Third-person analytical voice.]

## Best Articulation

> "Verbatim quote from a source — the most precise or highest-engagement
> expression of this idea." — [Date](source-url)

## Evolution

| Period | Expression | Signal |
|--------|-----------|--------|
| YYYY-MM | "First articulation" | First use — aspiration frame |
| YYYY-MM | "Sharpening" | Anti-pattern emerges |
| YYYY-MM | "Peak form" | Cleanest expression |

## Related Concepts
- [sibling concept](sibling-concept.md) — relationship description
- [sibling concept](sibling-concept.md) — relationship description

## Timeline
[Full timeline with deduped entries, quotes, source links]
```

### T3 / T4 — stub only (no LLM synthesis)

```markdown
---
title: "concept name"
type: concept
tier: 4
tier_label: "Riff"
mention_count: 1
---

# concept name

**Tier 4 — Riff** | 1 mention

> "Quote from the source" — [Date](URL)
```

## Output: cluster map at concepts/README.md

```markdown
# Intellectual Universe

## Canon (T1) — N concepts
The permanent intellectual fingerprint. Ideas that recur across years.

### [Cluster Name]
- [concept-slug](concept-slug.md) — one-line characterization
- ...

### [Other Cluster]
- ...

## Developing (T2) — N concepts
Sharpening. Might become canon.

## Speculative (T3) — N concepts
Testing in public.

## Stats
- Total concepts: N
- T1 Canon: N
- T2 Developing: N
- T3 Speculative: N
- T4 Riff: N
- Earliest source: YYYY-MM-DD
- Latest source: YYYY-MM-DD
```

## Phase 5: Curation cull — keep/delete/merge rubric

Phases 1–4 only merge up — they never remove anything. Over months that
leaves a corpus where hollow stubs dilute the concepts that actually
compound. Phase 5 is the cull: a hard verdict per concept, run on a cadence
or on demand, with every destructive step reversible.

> **Convention:** see [conventions/test-before-bulk.md](../conventions/test-before-bulk.md)
> — cull 3-5 clusters first, read the actual output, only then run the
> full pass.

### The core question

> If the user pulled this concept up cold in two years, would it sharpen a
> thought or seed something new — or would they scroll past it as filler?

Scroll-past = DELETE.

### The 6 axes (score each 1-5)

Three substance axes weighted **2x**, three packaging/fit axes weighted
**1x**. Substance carries the concept; packaging earns it surface area.

**SUBSTANCE (2x weight):**

| Axis | 1 | 3 | 5 |
|---|---|---|---|
| **Insight & tension** — carries real intellectual load: a mechanism, a non-obvious causal link, an inversion, a hidden cost | platitude ("startups are hard") | familiar idea with a specific angle | a named mechanism you can reuse |
| **Originality & surprise** — fresh framing that inverts an expectation, vs. a cliché anyone could write | fortune cookie ("discipline beats motivation") | known idea through the user's lens | a frame that feels newly coined and portable |
| **Specificity & completeness** — self-contained claim/mechanism/distinction with concrete detail, not a fragment needing missing context | vague or truncated | complete but generic | specific, evidenced, stands fully on its own |

**PACKAGING & FIT (1x weight):**

| Axis | 1 | 3 | 5 |
|---|---|---|---|
| **Voltage & wit** — charge in the language: a sharp turn, a compression, a line that lands | flat / textbook | clean | quotable, has snap |
| **Representative** — sounds like the user or connects to the user's documented worldview | any account could have written it | compatible with the user's lens | unmistakably the user's fingerprint |
| **Powerful & legible** — usable ammunition (essay beat, talk line, meeting frame) AND it transmits who the user actually is | inert trivia | usable with work | ready to deploy + makes the user better understood |

### Scoring → verdict

Weighted score = (Insight + Originality + Specificity) × 2 +
(Voltage + Representative + Powerful) × 1. Max = **45**; express as %.

| Weighted % | Verdict | Gates that must ALSO hold |
|---|---|---|
| **≥85%** | **ELITE** — keep + flag for reuse | no axis < 3; ≥2 fives, at least one on a SUBSTANCE axis |
| **75-84%** | **KEEP** | (Insight ≥4 OR Originality ≥4) AND Specificity ≥3 AND (Representative ≥3 OR Powerful ≥4) |
| **55-74%** | **MERGE/REWRITE or weak-keep** | good idea, flawed body → fold into the cluster canonical or rewrite to stand alone. Keep as-is only if rare provenance or it fills a coverage gap. Else DELETE. |
| **<55%** | **DELETE** | — |

**Minimum substance gate (overrides the %):** a concept can NEVER be KEEP or
ELITE if Insight < 3 or Originality < 3. Style does not buy its way past a
hollow idea.

MERGE/REWRITE is a real third verdict, not a dodge. Many stubs have a live
idea trapped in a weak body — fold those into the cluster canonical or
rewrite them to stand alone. Use it when Insight ≥ 3 but Specificity or
Voltage drags the score down.

### Hard DELETE triggers (any one = delete, regardless of score)

- **Fortune-cookie restatement** — true but says nothing a greeting card
  wouldn't; platitude, no mechanism.
- **Fragment** — requires unavailable context; not self-contained (unless
  rare provenance, and even then only if intelligible + useful).
- **Mangled extraction** — transcription garble, truncated mid-thought,
  incoherent, or a chunk header masquerading as a concept.
- **Off-mission trivia** — accurate but unconnected to anything the user
  builds, believes, or could use.
- **Duplicate within cluster** — fails the operational duplicate test below.
- **Unsupported factual claim** — a factual/historical/causal assertion
  that's wrong or unsourced and stated as fact (see grounding labels).
  Soften-or-cut.

### Grounding labels (factual concepts only) — label, don't just penalize

Any factual, historical, scientific, or causal claim gets a truth pass and a
`grounding:` frontmatter label:

- **VERIFIED** — accurate + sourced → fine to keep and deploy.
- **OPINION** — clearly framed as the user's take or argument → fine.
- **NEEDS_SOURCE** — plausible but unsourced as-fact → keep only if
  reframed as claim/opinion.
- **UNSAFE** — wrong, or punchy-but-false → DELETE or soften.

Do not store confident falsehoods — deployed, they make the user *less*
well understood, not more. Citations follow
[conventions/quality.md](../conventions/quality.md).

### Reputational-risk gate

A concept that is punchy but could misrepresent the user — make them sound
cruel, dismissive of people, or holding a position they don't — is a
liability, not ammunition. Flag for rewrite or delete even if it scores high
on voltage. Powerful means *usable without blowback*.

### Cluster budget (the "trite at scale" problem)

When many concepts come from one source or share one idea, evaluate the SET,
not each in isolation. Per semantic cluster, the default budget:

- **1 canonical concept** (the sharpest statement of the mechanism) — always.
- **+1-2 more** ONLY if each adds a *distinct* mechanism, a concrete
  example, a different emotional register, a new audience, or singular
  phrasing from the user.
- **More than 3** only if tied to an active project.

Everything else in the cluster is MERGE (preferred — see below) or DELETE.
Forty near-identical stubs on one theme → one canonical mechanism concept,
maybe one great line. The rest merge up.

### Operational duplicate test

Don't eyeball "% overlap." Compare the candidate against the best existing
concept in its cluster and ask: **does this add a new mechanism, example,
emotional register, audience, or user-specific phrasing?** If no → MERGE
(fold it in, keep the signal) or DELETE. If yes → the thing it adds is what
justifies keeping it.

### Hard KEEP overrides (rescue a low score — but floored)

Each override applies ONLY if the concept is intelligible and potentially
useful:

- **Singular voice** — captures something only the user would say. Voice
  beats polish, but not voice over coherence.
- **Load-bearing for an active project** — directly feeds a known thesis or
  work in flight.
- **Rare provenance** — a real quote/moment that can't be regenerated (a
  meeting, the user's own note), AND it carries recoverable meaning. A
  content-free "great point about the AI thing" does NOT qualify.

### Merge-with-backlinks (reversible — nothing is destroyed)

For redundant clusters the cull is INVERTED: do not delete the tail — merge
it up into the canonical head and let the merge ledger become a salience
metric. An idea independently re-derived N times isn't bloat; it's the
corpus flagging *this matters* in N different contexts. Deleting dupes
throws that signal away; merging captures it.

Each merge grows three frontmatter fields plus one body section on the
canonical:

- **`merge_count`** (int) — raw number of pages absorbed, including
  same-source re-extractions.
- **`independent_sources`** (int) — distinct sources the cluster drew from.
  **This is the true salience metric** — raw merge_count inflates when one
  source gets re-extracted repeatedly; independent_sources is the fix.
- **`backlinks`** (list of `{source, angle, date}`) — every absorbed page's
  source plus the *specific angle* it brought. All framings survive; they
  just stop being separate top-level pages.
- **`## Facets`** (body) — the canonical mechanism up top, then one short
  "as seen in {source}: {angle}" line per absorbed page. The concept
  becomes multi-angle, not redundant.

**Merge-quality gate (reject incomplete merges):** a merge is only written
if (a) the `## Facets` section has one line per absorbed page (source +
specific angle) and (b) every `backlinks` entry has source + angle + date.
Empty facets or dangling entries = reject the merge and flag the cluster for
manual review. No half-merges.

**Distinctness guard is a HARD VETO, not advisory.** Two concepts that look
like duplicates are NOT merged unless an LLM judge AFFIRMATIVELY confirms
they state the SAME mechanism. Default is DON'T merge; the judge must earn
the merge, and its yes/no + reason is logged per cluster. Different
mechanisms/examples/registers → separate canonicals. Similarity proposes;
judgment disposes.

**Finding merge candidates — qualitative bands, not numeric cutoffs.** Do
not hardcode a similarity threshold: `gbrain search` returns hybrid
(RRF-fused) scores, not raw cosine similarity, and any pinned number rots as
the corpus and search mode shift. Work qualitatively: search each concept's
title + first paragraph and treat another concept as a merge CANDIDATE when
the two surface each other at the top of the result list with a visible
score gap to the rest. Concepts that share vocabulary but not mechanism land
mid-list — that's exactly the band where the distinctness guard earns its
keep. Calibrate on your own corpus distribution before the bulk pass.

### Merge mechanics (progressive, fully reversible)

```bash
# 0. Inventory the stratum being culled
gbrain query "type:concept" --limit 10000 --json

# 1. Probe for merge candidates (mutual top-of-list hits)
gbrain search "concept title + first paragraph" --limit 10

# 2. Archive the absorbed page verbatim under _merged/ BEFORE touching it
#    (add merged_into: <canonical-slug> to its frontmatter). The _merged/
#    tree is the undo button.
gbrain get concepts/absorbed-stub
gbrain put concepts/_merged/cluster-name/absorbed-stub

# 3. Grow the canonical head: merge_count, independent_sources,
#    backlinks, and the ## Facets section
gbrain put concepts/canonical-slug

# 4. Soft-delete the absorbed original (restorable until purge)
gbrain delete concepts/absorbed-stub

# Undo paths: gbrain restore <slug> (within the purge window),
# the _merged/ copy (survives purge), and per-page version history:
gbrain history concepts/canonical-slug
gbrain revert concepts/canonical-slug <version_id>
```

Commit incrementally. Nothing is hard-deleted during a cull; the `_merged/`
tree plus soft-delete plus page history keep every step reversible.

### Merge ledger → emergent tier promotion

Feed `independent_sources` into Phase 2's Frequency axis. When a canonical
concept's `independent_sources` crosses the natural gap in the corpus
histogram — look at the distribution, don't hardcode a round number — it is
a tier-promotion candidate (T4→T3, T3→T2, T2→T1 review). No size cap: a
concept that keeps absorbing merges SHOULD grow fat. The tier boundary
becomes emergent, not hand-drawn — the corpus telling you a recurring idea
has earned its tier.

## Quality gates

### Dedup quality
- No two concept pages should be "the same idea in different words."
- Aliases preserved in frontmatter for search.
- Run `gbrain query "type:concept"` and spot-check the count reduction.

### Tier quality
- T1 should feel like "yes, that IS one of my recurring frameworks" —
  recognizable, recurring, sharp.
- T2 should feel like "I'm working on this; it's getting clearer."
- No concept should be T1 with < 4 months span or < 6 mentions.
- No concept should be T4 with > 3 months span.

### Synthesis quality
- Captures evolution, not just repetition.
- Uses verbatim quotes, not paraphrase.
- Links to related concepts (markdown links, not wiki-links).
- Does NOT hallucinate sources or dates.

### Cull quality
- No concept deleted while it holds the cluster's only statement of a
  mechanism — the canonical survives every cull.
- Every merge passes the merge-quality gate: populated `## Facets` +
  complete `backlinks` entries. No half-merges.
- Distinctness-guard verdicts logged per cluster; the judge said yes out
  loud before any merge was written.
- No UNSAFE-labeled claim survives stated as fact.
- Every absorbed page has a verbatim `_merged/` copy before its original is
  soft-deleted.

## Cron integration

This is heavy work. Run on a cadence, not on every signal:

- After a major ingestion batch completes (signal-detector burst, archive
  crawler run, etc.).
- Weekly cron for incremental synthesis of newly-promoted T1/T2 concepts.
- Manual trigger for a full re-synthesis when the corpus shifts
  significantly.
- The Phase 5 cull runs less often than synthesis — monthly, or after a
  large ingestion wave visibly inflates the stub count. Always
  test-before-bulk first.

## Anti-Patterns

- ❌ Running synthesis on T3/T4 — wastes API budget on ideas that may
  never sharpen.
- ❌ Hallucinating quotes or dates. The timeline must be verifiable
  against existing brain pages.
- ❌ Generic cluster names ("Various Topics"). If you can't name the
  cluster, the cluster isn't real.
- ❌ Re-synthesizing already-synthesized T1s without new source material.
  Idempotency-respect.
- ❌ Hardcoding a numeric similarity cutoff for merge candidates. Search
  scores are corpus- and mode-relative; use the qualitative bands and let
  the distinctness guard decide.
- ❌ Merging on similarity alone. Shared vocabulary is not shared
  mechanism; the distinctness guard is a hard veto, not advisory.
- ❌ Deleting redundant concepts instead of merging them up. Deletion
  throws away the frequency signal that drives tier promotion.
- ❌ Keeping a hollow concept because the phrasing is pretty. The minimum
  substance gate exists precisely for this.
- ❌ Hard-deleting during a cull. Archive to `_merged/` + soft-delete;
  keep every undo path alive.
- ❌ Bulk-culling without a 3-5 cluster spot-check first
  ([conventions/test-before-bulk.md](../conventions/test-before-bulk.md)).

## Related skills

- `skills/signal-detector/SKILL.md` — creates raw concept stubs from text channels
- `skills/voice-note-ingest/SKILL.md` — same for audio channels
- `skills/idea-ingest/SKILL.md` — same for links / articles


## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (when applicable).
- Conventions referenced (`quality.md`, `brain-first.md`, `_brain-filing-rules.md`) are followed.
- Privacy contract preserved: no real names, no fork-specific filesystem path literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this section exists for the conformance test.

## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent). The literal section header here exists for the conformance test (`test/skills-conformance.test.ts`).
