# Push-based context (#2095, v0.43)

Retrieval used to be pull-only: the agent had to *know to ask* before the brain
contributed anything. Push-based context inverts that — the brain volunteers
relevant pages from the recent conversation, confidence-gated so push noise
never becomes worse than pull silence.

Three channels share one zero-LLM core (`src/core/context/volunteer.ts`):

| Channel | Surface | When to use |
|---|---|---|
| `reflex` | automatic, inside the context engine | default-on for plugin hosts; nothing to call |
| `op` | `gbrain volunteer-context` / MCP `volunteer_context` | agents without the plugin; one call per turn |
| `watch` | `gbrain watch` | stream a transcript in, volunteered pages stream out |

## How it decides

1. **Extract** entities across the last N turns (capitalized runs, `@handles`),
   merged with recency / frequency / user-role salience. Assistant-introduced
   entities and "what did she invest in?" follow-ups whose antecedent was named
   in the window now resolve.
2. **Resolve** through the alias table, exact titles, and slug suffixes — each
   arm carries an honest confidence: alias 0.9, exact title 0.8, slug-suffix 0.6,
   +0.05 when mentioned in ≥2 turns or the newest turn.
3. **Gate** at `min_confidence` (default 0.7 — slug-suffix matches need an
   explicit lower gate), suppress pages already surfaced (slug-presence only),
   cap at 3 pages (hard cap 5).

## CLI

```bash
# one-shot: pipe recent turns (oldest → newest)
printf 'user: ask alice-example about the deal\nassistant: noted\nuser: what did she say?\n' \
  | gbrain volunteer-context

# streaming: volunteered pages print as the transcript flows
some-transcript-feed | gbrain watch --json

# the feedback loop: how often were volunteered pages actually opened?
gbrain volunteer-context --stats
```

Stats are **approximate** by design: "used" means `pages.last_retrieved_at >
volunteered_at` — the 5-minute last-retrieved throttle causes false negatives
and unrelated reads of the same page cause false positives. Use the per-arm
precision to tune `min_confidence`, not as an exact metric.

## Config

| Key | Default | What it does |
|---|---|---|
| `retrieval_reflex_window_turns` | 4 | turns the ambient reflex extracts from; 1 = legacy current-turn-only (file/env plane: `GBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS`) |
| `retrieval_reflex` | true | the ambient channel's master switch |
| `retrieval_reflex_max_pointers` | 3 | pointer cap per turn |

Per-call knobs on the op/watch: `max_pages`, `min_confidence`, `session_id`,
`turn` (attribution columns in the feedback log).

## Storage + privacy

Volunteered pages log to `context_volunteer_events` (migration v117): slug,
arm, confidence, channel, optional session/turn — the rationale is a
deterministic template string, never raw conversation text. Rows are pruned
after 90 days by the dream cycle's purge phase. Synopses pass through the same
takes/facts-fence privacy boundary as `get_page`.
