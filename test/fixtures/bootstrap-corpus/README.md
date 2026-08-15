# bootstrap-corpus fixture

A tiny, hermetic, 100% synthetic brain corpus used by the agent-bootstrap end-to-end
tests. It is curated and re-authored (not copied wholesale) from the public gbrain-evals
synthetic corpora — `eval/data/synthetic-v1` (interlinked markdown pages with frontmatter,
`[[wikilinks]]`, and `## Timeline` sections), `eval/data/world-v1` (compiled-truth entity
JSON), and `eval/precisionmembench/fixtures` (preference/belief objects with visibility +
confidence). Every name here is an obvious placeholder (`alice-example`, `ridge-platform`,
`summit-robotics`, `vector-co`, …); no real person, company, or fund appears, per the repo
privacy iron rule.

Contents:

- `pages/*.md` — 12 interlinked pages (people, companies, concepts, meetings) with YAML
  frontmatter and `[[wikilinks]]`. Filenames flatten the slug: `companies__ridge-platform.md`
  loads as slug `companies/ridge-platform`. Four pages carry a `## Timeline` section.
- `beliefs.json` — belief/fact objects `{ text, entity_slug, visibility, confidence }`, a
  mix of `world` and `private`, so a visibility-fence recall test can assert the private
  ones are never surfaced.
- `queries.json` — gold recall cases `{ id, kind, query, expect_slug?, expect_substring?,
  must_not_substring? }`, each with a deterministic answer given the pages/beliefs above.

The loader in `test/helpers/bootstrap-corpus.ts` reads these files and writes the pages
through the real `put_page` operation handler (so auto-link, chunking, and search-vector
fire) and the beliefs through `engine.insertFact` (honoring each belief's visibility).
`loadCorpusQueries()` returns the parsed gold cases. Consume the loader read-only; do not
mutate the fixtures from a test.
