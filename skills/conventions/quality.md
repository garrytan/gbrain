# Quality Convention

Cross-cutting quality rules for all brain-writing skills.

## Excerpts and summaries

Keep Markdown structure separate from excerpt text. Under `## Summary`, put
speaker labels on their own `###` line, then a blank line and the excerpt.
Never flatten `## Assistant` (or another role heading) together with a
message into a single heading. Check generated pages with `gbrain lint`
before publishing; `chat-summary-heading` identifies this legacy shape on
valid `type: source` pages labeled `**Source:** ChatGPT Export` or
`**Source:** Claude Export`, and
`--fix` repairs its empty role section without rewriting the excerpt.
Raw conversation imports preserve the transcript and follow
[conversation-archive](../conversation-archive/SKILL.md); they are not summary pages.

## Citations (MANDATORY)

Every fact written to a brain page must carry an inline `[Source: ...]` citation.

- **User's statements:** `[Source: User, {context}, YYYY-MM-DD]`
- **Meeting data:** `[Source: Meeting "{title}", YYYY-MM-DD]`
- **Email/message:** `[Source: email from {name} re: {subject}, YYYY-MM-DD]`
- **Web content:** `[Source: {publication}, {URL}, YYYY-MM-DD]`
- **Social media:** `[Source: X/@handle, YYYY-MM-DD](URL)`
- **Synthesis:** `[Source: compiled from {sources}]`

### Source precedence (highest to lowest)

1. User's direct statements (highest authority)
2. Compiled truth (brain's synthesized understanding)
3. Timeline entries (raw evidence)
4. External sources (API enrichment, web search)

## Back-Linking (MANDATORY)

Every mention of a person or company WITH a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them.

Format: `- **YYYY-MM-DD** | Referenced in [page title](path) -- context`

An unlinked mention is a broken brain.

## Notability Gate

Before creating a new brain page, check notability:

- **People:** Will you interact again? Relevant to work/interests?
- **Companies:** Relevant to work/investments/interests?
- **Concepts:** Reusable mental model? Worth referencing again?

When in doubt, DON'T create. A 400-follower person who tweeted once is not notable.
