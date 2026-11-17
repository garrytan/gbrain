**Conversation facts about a person or company with no page keep a name tag, so their history can be grouped without creating pages.**

### Changed
- `gbrain extract-conversation-facts` keeps a name tag on a fact whose person or company was named in full but has no page. The tag is the name in slug form without a folder (`alice-example`), where the fact used to have no entity at all. A single word (a first name, a topic) keeps no tag. No page is created and page lists never show a tag. The fact also gets a role, employer or city slot from the existing small tagging call. Only new extractions get tags. Off with `gbrain config set facts.unbacked_entity_keys false`.
- Forgetting or purging a fact on a name tag applies to that claim across the whole source, and a claim forgotten or purged for anyone stays out of a tag, so a page written later or a tag moved onto a page never brings it back (schema migration v321 updates the facts guards). Like a fact with no entity, forgetting a tag fact refuses with `claim_linked` while the same claim is active on another person's or company's fact, and a member forgetting a fact on their own memory page never reaches a tag. Facts already stored on a bare slug with no page (written before 0.60.162.0) are treated the same way.
- A private page at `<folder>/<tag>` (people, companies, orgs, organizations, funds, hosts, projects or concepts) keeps the tag's facts from every remote caller who cannot read that page.
- The consolidate phase no longer reads facts whose entity has no page; it skipped them after reading before.

### Added
- `gbrain facts relink --conversation --unbacked` moves the facts on a name tag onto the page the name now resolves to (its file name, a unique alias, or the same name without a company suffix; a merged page hands them to its target), free, preview first with `--dry-run`. The facts relink guide explains how to separate two people who share a full name.
- A `query` with a token budget that asks for one person's history in one slot (which job titles, employers or cities, oldest first or over time) gets every value that person or name tag has had in that slot that the caller may read, oldest first, each with its validity window, inside the facts block's existing share. A name tag is found when the question holds its full name and no other tag matches. A failed history read keeps the block and is reported as the degraded stage `facts_history_unavailable`.

<!-- behavior-change: conversation_name_keys_gbra574 -->
