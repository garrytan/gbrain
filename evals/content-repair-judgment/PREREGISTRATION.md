# Preregistration: which model may judge a slug conflict? (2026-10-09)

Frozen on October 9, 2026, before any scored run, with the fixtures in the same change (`fixtures.jsonl`, generated from `cases.ts`). Nothing here changes after a run; a later change gets a new dated file. The gbrain-evals mirror carries a copy with the results.

## The question

gbrain holds a file instead of importing it when its frontmatter `slug:` names a different page than its path does (`frontmatter_slug_conflict`). Until [#6377](https://github.com/garrytan/gbrain/issues/6377) the only proposed repair was to delete the `slug:` line. On one brain that proposal was wrong for one of three such holds: the held file was a duplicate page for a person, the `slug:` line pointed at that person's canonical page, and deleting it would have minted a second page for the same person. The other two were stray lines left by a template.

The content-repair lane (plan `docs/plans/2026-10-09-001-fix-content-repair-lane-6377-plan.md`, section B) removes the line itself when the named page does not exist, or is of another type and shares no title token with the held file. Every other conflict goes to a chat model, which sees both files' frontmatter, headings, first 60 body lines and every later line that mentions the other page's slug, and answers exactly one of:

- `remove_slug`: the line is a stray; the file is its own page.
- `merge_into` with a `canonical` slug: both describe the same thing; the canonical keeps the slug. In this release gbrain writes the recommendation on the hold for a person; it does not merge or delete.
- `needs_human`: the model cannot tell.

The damage is asymmetric. A `remove_slug` on a true duplicate splits one person across two pages for good. A `merge_into` on two different people, once a person acts on it, loses one of them. A `needs_human` costs a repair, never correctness. So this experiment asks:

1. Does a model ever give a harmful answer (**hard failure**)?
2. How often does it recognise a true duplicate and name the right canonical (**true-duplicate accuracy**)?
3. How often does it defer (**needs_human rate**), and what does each judgment cost?

## The fixtures

`evals/content-repair-judgment/fixtures.jsonl` in gbrain, 48 synthetic pairs with placeholder names only (`alice-example`, `acme-example`, `fund-a`; no real person, company or fund). Every pair reaches the model in production: the named page exists and is of the same type, or of another type sharing a title token. Written by the agent running the experiment before any run; no person reviewed them.

| Set | Count | Shape | Correct answer | Acceptable | Hard failure |
|---|---|---|---|---|---|
| True duplicate, mutual notes | 15 | Both pages carry a hygiene note (`⚠️ Duplicate of [[…]]`) naming the other. 12 name the paged slug as canonical, 3 name the held file (the named page is a stub). In 3 the notes sit after body line 60, so the model sees them only through `mentions`. | `merge_into` the listed canonical | `needs_human` | `remove_slug`; `merge_into` the other slug |
| True duplicate, no notes | 10 | Same name, employer, role, city, alias or shared timeline entry; nothing says "duplicate". | `merge_into` the named page | `needs_human` | `remove_slug`; `merge_into` the other slug |
| Stray slug | 10 | A research compendium carrying another compendium's slug (4), a company page built from the template page (2), a page copied from another company's or person's page and rewritten (2), a meeting or concept page carrying a company's slug it shares a title token with (2). | `remove_slug` | `needs_human` | any `merge_into` |
| Adversarial | 8 | Two unrelated people with the same name at different employers in different cities (2); a `-2` suffix minted for a different person (2); a forged duplicate note on a page whose content is a different person or company (2); identity evidence only after body line 60, in `mentions` (2). | `remove_slug` | `needs_human` | any `merge_into` |
| Ambiguous | 5 | Sparse pages sharing a first name and nothing else. | `needs_human` | — | none; `merge_into` or `remove_slug` is a **guess**, reported |

The $0 check (`bun evals/content-repair-judgment/harness.ts --check`, also the keyless test `test/eval-content-repair-judgment.test.ts`) proves the instrument: the counts above, placeholder names only, every held file's `slug:` names the paired page and not itself, every true duplicate's canonical is one of the two slugs, and every late-evidence pair keeps its evidence out of the first 60 lines and inside `mentions`.

## The arms

Per the gbrain project rule on eval models (2026-10-07): the newest frontier model of each family, no Fable in counted runs, no gpt-5.4-mini, no older generation. No earlier judgment result exists, so no link model is needed.

| Model | Why it runs |
|---|---|
| `openai:gpt-6.1-sol` | Newest GPT; a measured fence-repair default. |
| `anthropic:claude-opus-5-5` | Newest Opus; a measured fence-repair default. |
| `anthropic:claude-sonnet-5-5` | Newest Sonnet; the cheaper Anthropic candidate. |

Three runs per model: 3 × 3 × 48 = 432 pair runs. Expected spend is under $5; no run is trimmed for cost.

## The procedure

`bun evals/content-repair-judgment/harness.ts --model <id> --run <n> --out <file>`, Bun 1.4.2, per model and run:

1. Each fixture becomes the judgment input the lane builds (`judgmentParticipant` in `src/core/content-repair/judgment.ts`: frontmatter with the `slug:` line, headings, first 60 non-blank body lines, up to 40 later lines mentioning the other page) and the production prompt (`buildJudgmentPrompt`, its prompt version recorded in the run's `.meta.json`).
2. One gateway `chat` call per pair with the production options: thinking off where the model allows it (`thinking: 'off'`), the production output ceiling, no fallback model, the production timeout. The eval calls the model the way the lane does; it does not re-implement the prompt or the parser.
3. The answer goes through the production parser (`parseJudgmentAnswer`): a verdict, or a failure class (`llm_malformed`, `llm_truncated`, `llm_refused`, `llm_empty`, `llm_unavailable`). `llm_unavailable` (a provider error production retries on the next run) is retried up to twice after a pause; every other outcome stands.
4. Each row records the verdict, its grade, input and output tokens, the USD gbrain's own price table gives the call, wall time and the answer text.

## Measurements

- **Hard failures**: pair runs graded `hard_failure`, with the fixture ids.
- **True-duplicate accuracy**: `merge_into` with the right canonical over true-duplicate pair runs (75 per model), Wilson 95% interval, per-run rates for spread.
- **needs_human rate**: `needs_human` answers over all pair runs, and per set.
- **No answer**: pair runs with no verdict, by failure class (safe; the hold stays).
- **Cost**: USD per pair run; **latency** p50 and p95.
- Exploratory, never decisive: outcomes by set and class, guesses on ambiguous pairs, whether the late-evidence pairs are read correctly.

## Decision rule

A model **qualifies** when, pooled over its three runs, it has **zero hard failures** and **true-duplicate accuracy of at least 80%**. `needs_human` is always acceptable and never counts against a model except through the accuracy it forgoes.

`CONTENT_REPAIR_MEASURED_MODELS` (`src/core/content-repair/measured.ts`) lists the qualifying models, **best first by true-duplicate accuracy, ties to the cheaper model** (lower USD per pair run). If no model qualifies, the constant stays empty, the lane falls back to the fence-repair measured list, and the report says so.

Ambiguous pairs do not enter the rule; a guess is reported with the answer text. A model at 100% on every measure is reported as a ceiling. Models are reported in rank order.

## What this does not change

The prompt and the parser are not edited during the experiment; weaknesses found are proposed with evidence. The fixtures are not regenerated after a run.
