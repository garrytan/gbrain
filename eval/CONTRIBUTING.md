# Contributing to BrainBench

Three contribution paths. Each has a separate workflow.

## 1. Write Tier 5.5 externally-authored queries

Tier 5.5 exists to neutralize the "gbrain wrote its own exam" critique. The
queries currently in the repo are AI-authored synthetic placeholders; real
outside researcher submissions supersede them.

### Workflow

```sh
# Step 1. Understand the canonical world.
bun run eval:world:view
# Browser opens. Click through entities. Note down what's real.

# Step 2. Scaffold a query.
bun run eval:query:new --tier externally-authored --author "@your-handle"
# Prints a Query template. Save to a file.

# Step 3. Edit the template.
# - Replace text with your actual question
# - Replace gold.relevant with slug(s) that actually exist
# - If the query has temporal verbs (is/was/were/now/...), set as_of_date
#   to "corpus-end", "per-source", or ISO-8601
# - Fill in tags

# Step 4. Validate before submitting.
bun run eval:query:validate path/to/your-queries.json

# Step 5. Submit a PR.
# File location: eval/external-authors/<your-handle>/queries.json
# PR template: .github/PULL_REQUEST_TEMPLATE/tier5-queries.md
```

### Query-authoring guidelines

- **Write like you'd naturally ask.** Don't adapt your voice to an "AI
  benchmark style." Fragments, typos, comparisons, follow-ups, imperatives
  — all welcome. Variety is the value.
- **Gold must be real slugs.** Every slug in `gold.relevant` must exist in
  `eval/data/world-v1/`. The validator checks format; you verify existence.
- **Abstention is a valid answer.** If your query has no answer in the
  corpus (e.g. you're asking about someone who isn't there), set
  `expected_output_type: 'abstention'` and `gold.expected_abstention: true`.
- **Temporal queries need `as_of_date`.** The validator will reject
  "Where is Sarah now?" without it. Use `"corpus-end"` for "as of the most
  recent data," `"per-source"` for "whatever the cited source says," or a
  specific ISO date.
- **Partial answers are OK** if you flag them via `known_failure_modes`.

### Query quality bar

We'll merge your PR if:
- `bun run eval:query:validate` passes
- Slugs resolve to real entities
- At least 20 queries (one batch)
- Queries have genuine phrasing variety

## 2. Submit an external adapter

The `Adapter` interface is `eval/runner/types.ts`. Three methods:

```typescript
interface Adapter {
  readonly name: string;
  init(rawPages: Page[], config: AdapterConfig): Promise<BrainState>;
  query(q: Query, state: BrainState): Promise<RankedDoc[]>;
  snapshot?(state: BrainState): Promise<string>;
}
```

### Workflow

```sh
# Step 1. Create your adapter file.
#   eval/runner/adapters/my-adapter.ts

# Step 2. Write it.
#   - import types from '../types.ts'
#   - export class MyAdapter implements Adapter { ... }
#   - BrainState is opaque to the runner. Internal shape is yours.
#   - `rawPages: Page[]` is all you get. Never read from gold/ — the
#     runner doesn't give you that path on purpose.

# Step 3. Write a unit test.
#   eval/runner/adapters/my-adapter.test.ts
#   Cover at minimum: init, query, deterministic tie-break.

# Step 4. Wire into multi-adapter.ts.
#   import { MyAdapter } from './adapters/my-adapter.ts';
#   const allAdapters: Adapter[] = [
#     ...existing,
#     new MyAdapter(),
#   ];

# Step 5. Test locally.
bun run test:eval
bun run eval:run:dev --adapter=my-adapter

# Step 6. Open a PR.
```

### Adapter quality bar

- Deterministic over sorted input (stddev=0 across N=5 runs is the
  expected default; non-zero is a signal worth understanding)
- `query()` returns rank order — `rank: i + 1`, 1-based, no duplicates
- Tie-breaks documented (e.g. "alphabetical by slug when scores tie")
- No network calls in unit tests (mock any API dependencies)
- Pass `bun run test:eval`

## 3. Reproduce / verify a published scorecard

```sh
# Step 1. Check the scorecard's commit hash.
# Reports in docs/benchmarks/ include the gbrain version + commit.

# Step 2. Pin the same commit.
git checkout <commit-sha>

# Step 3. Run the full benchmark.
bun run eval:run

# Step 4. Compare to the published scorecard.
# For deterministic adapters, numbers should match exactly.
# For embedding-based adapters, numbers should land within the published
# tolerance bands (mean ± stddev).
```

If your numbers drift outside tolerance, file an issue with:
- Your `bun --version`
- Your `uname -sr`
- Your OpenAI model ID (for embedding-model drift)
- A diff of the scorecard

## Code style

- Match existing gbrain patterns (hand-rolled where appropriate, no new
  deps unless genuinely needed)
- Bun's built-in test runner (`bun:test`), not jest/vitest
- No em dashes in prose (`—`, `–`); use parentheses or sentences
- Commit messages: `feat(eval):`, `fix(eval):`, `docs(eval):`, `test(eval):`

## Contributors

See `eval/CREDITS.md` for the full list. All Tier 5.5 external-author
submissions credited there + in the scorecard. Synthetic placeholders are
labeled `synthetic-outsider-v1`.
