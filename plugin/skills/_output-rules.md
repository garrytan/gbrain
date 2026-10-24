# Output Rules

Cross-cutting output quality standards for all brain-writing skills.

## Deterministic Links

All links in brain pages MUST be deterministic (built from actual data, not composed
by the LLM). Never guess a URL or path. Build it from the slug, the commit hash, or
the API response.

- Brain page links: `[page title](type/slug.md)`
- Commit links: `[abc1234](https://github.com/{owner}/{repo}/commit/abc1234)`
- External links: use the actual URL from the source, never reconstruct it

### Scope split: in-page vs in-message

The two output surfaces take OPPOSITE link forms:

- **In-page (inside a brain page):** RELATIVE markdown links
  (`[page title](type/slug.md)`). gbrain's link extraction builds the
  links/backlinks graph — which powers relational retrieval — from
  filesystem-relative links. An absolute URL between two brain pages is
  invisible to that graph. Absolute URLs in a page body are for genuinely
  external targets only; frontmatter `related:`/`people:` keys stay bare
  relative paths.
- **In-message (chat deliverables that reference a brain page):** absolute,
  VERIFIED links — or the fallback chain below. Repo-relative paths aren't
  clickable in chat surfaces.

### Verified-deliverable-link canon

A link handed to the user as part of a deliverable must be:

1. **Built from actual data** — repo-relative path from
   `git ls-files --full-name`, remote from `git remote get-url origin`;
   never composed from memory.
2. **Pushed before linked** — a hosted URL 404s until the push lands.
3. **Verified to resolve** when a hosted remote exists (the push's
   ref-update output stands as evidence when the host API lags).

Fallback chain when the brain has no hosted remote (or verification fails):
hosted git-remote URL (verified) → repo-relative path plus a note that it's
local → `gbrain publish` output offered as an attachable HTML ARTIFACT (it
emits a local file path — never promise it as a URL).

Mechanics — path derivation, push-before-link ordering, subagent-relay
rewriting, bulk-list formatting: `skills/brain-link-discipline/SKILL.md`.

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
