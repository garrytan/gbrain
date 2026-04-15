# Output Rules

Cross-cutting output quality standards for all brain-writing skills.

## Deterministic Links

All links in brain pages MUST be deterministic (built from actual data, not composed
by the LLM). Never guess a URL or path. Build it from the slug, the commit hash, or
the API response.

- Brain page links: `[page title](type/slug.md)`
- Commit links: `[abc1234](https://github.com/{owner}/{repo}/commit/abc1234)`
- External links: use the actual URL from the source, never reconstruct it

## No Slop

Brain pages are not chat output. They are durable knowledge artifacts.

- No filler phrases ("It's worth noting that...", "Interestingly...")
- No hedging when facts are cited ("According to the source, X is true" not "X might be true")
- No LLM preamble ("I've created...", "Here's the updated...", "Certainly!")
- No placeholder dates ("YYYY-MM-DD", "recently", "in the near future")
- Short paragraphs. Concrete facts. Inline citations.

## Exact Phrasing Preservation

When capturing someone's original thinking, use their exact words. Don't paraphrase.
Don't clean up grammar. The language IS the insight.

- Direct quotes: preserve verbatim in quote blocks
- Ideas and frameworks: use the person's own terminology for slugs and titles
- Observations: capture the phrasing, not a sanitized version

## Title Quality

Page titles should be:
- Descriptive enough to identify the page from a search result
- Short enough to scan in a list (under 60 characters)
- NOT sentences ("Meeting with Pedro" not "Meeting with Pedro about the new deal structure")
- NOT generic ("Pedro Franceschi" not "Person Page")
