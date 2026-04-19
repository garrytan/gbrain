<!--
Tier 5.5 Externally-Authored Query Submission template
See eval/CONTRIBUTING.md for the full workflow.
-->

## Summary

Submitting **N** Tier 5.5 queries for BrainBench.

- Author handle: `@your-handle`
- File location: `eval/external-authors/your-handle/queries.json`
- Queries authored fresh (not copy-pasted from a model output)
- Slugs verified against `eval/data/world-v1/` (via `bun run eval:world:view`)

## Checklist

- [ ] `bun run eval:query:validate eval/external-authors/your-handle/queries.json` passes
- [ ] At least 20 queries
- [ ] Each query has either `gold.relevant` (with real slugs) or `gold.expected_abstention: true`
- [ ] Temporal queries have `as_of_date` set (`corpus-end` | `per-source` | ISO-8601)
- [ ] Phrasing is varied (not all the same template)
- [ ] `author` field matches my handle

## Phrasing variety (optional self-audit)

Tick the styles represented in your batch:

- [ ] Full sentence questions
- [ ] Fragment-style ("crypto founder Goldman Sachs background")
- [ ] Comparison ("X vs Y")
- [ ] Follow-up ("And who else...")
- [ ] Imperative ("Pull up Alice Davis")
- [ ] Trait-based ("the demanding engineering leader")
- [ ] Abstention bait (answer is "not in corpus")

## Notes to reviewer

Anything worth flagging — ambiguous cases, corpus gaps you found, specific
phrasings you were uncertain about.
