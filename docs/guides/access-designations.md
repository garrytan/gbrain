# Access designations: what each one means

This is the one definition of every access and visibility designation gbrain honours: what each one does to
retrieval, when a writer should use it, and who may set or clear it. The code that enforces it is
`src/core/search/private-visibility.ts` (privacy), `src/core/access/` (members, folder rules, the owner) and
`src/core/facts/visibility.ts` (facts). When this page and the code disagree, the code is right and this page is a bug.

**The default for an ordinary page is no designation.** Research notes, project and ops pages, people and company
pages, meeting notes you took and summaries of world pages carry no `visibility`, no `access` and no
`readable_by`. A personal brain should have very little marked private.

## Who reads what

Five kinds of caller read a brain:

- **Local CLI** on the brain host (`remote = false`). Reads everything.
- **The owner**: a remote credential (token or OAuth client) or stdio server bound to the member named by
  `gbrain access owner set <member>` (config `access.owner_member`). Bind each of the owner's agents, delegates and
  sub-agents included, with `gbrain auth rescope --token <name> --member <owner>` (stdio: `gbrain config set
  mcp.stdio_member <owner>`). On a single-user brain this is how the owner's own agent reads the whole brain.
- **Other members**: credentials bound to any other enabled member.
- **Public or unbound callers**: credentials bound to no member, and audiences that include a guest.
- **Shared rooms**: a shared agent speaking for an audience of several people (`X-Gbrain-On-Behalf-Of` /
  `_meta.on_behalf_of` with more than one entry, a group or a guest), and attested QM calls.

| Designation | Local CLI | Owner and the owner's bound delegates | Other members | Public or unbound | Shared rooms |
|---|---|---|---|---|---|
| none (the default) | reads | reads | reads | reads | reads |
| `visibility: private` | reads | reads | hidden | hidden | hidden |
| privacy alias (`access: private`, ...) with no `visibility` | reads | reads | hidden | hidden | hidden |
| derived page with no `visibility` (atom, pinned question, synthesized concept) | reads | reads | hidden | hidden | hidden |
| derived from a private page (lineage) | reads | reads | hidden | hidden | hidden |
| `pinned_question` | reads | reads | hidden | hidden | hidden |
| `readable_by: [...]` | reads | only when listed | only when listed | hidden | only when every entry is listed |
| folder rule (`gbrain access rule`) | reads | only when listed | only when listed | hidden | only when every entry is listed |
| derived from a `readable_by` page | reads | hidden | hidden | hidden | hidden |
| fact `visibility: private` | reads | `recall` reads | hidden | hidden | hidden |

"Hidden" means the same `not_found` a missing page gets, on every read path (get_page, search, query, recall, lists,
links, timelines, versions). The owner reads through `get_page`, `search`, `query`, `recall` and the other page
reads in every source its grant reads; the owner's source grant still bounds which sources those are. Facts outside
`recall` (hot memory, turn context, context packs) stay world-only for every remote caller, the owner included.

Two grants relax privacy for callers that are not the owner, and both are operator decisions:
`gbrain auth rescope --private-pages granted-sources` (private pages in the sources that grant names) and the
escape hatches `GBRAIN_REMOTE_PRIVATE_PAGES=1` / `gbrain config set search.remote_private_pages visible` (every
remote caller). Neither relaxes `readable_by` or folder rules, and neither reaches a shared-room audience.

`gbrain access check --token <name>` reports whether a credential reads as the owner, and
`gbrain <operation> --as <member>` previews a member's view, the owner's included. Every remote response names the
relaxation it was answered under in `_meta.access.relaxation` (`none`, `granted_sources`, `operator` or `owner`).

## Each designation

### No designation

A page with no `visibility`, no privacy alias and no `readable_by` is world: every caller entitled to its source
reads it. Use it for everything that is not one of the cases below. Anyone who may write the page may leave it so.

### `visibility: private`

Hides the page from every remote caller except the owner (and the two operator grants above). Facts, chronicle
events and timeline rows derived from it are private too. On a source with `canonical: git` a private page is
database-only: its bytes never enter Git history.

Use it only when the content genuinely needs it:
- another person's private information shared with you in confidence (a DM, someone's health or money details);
- something written for one shared room that must not reach the others;
- a page the owner explicitly asked to keep private.

Connectors set it for content that is private at its source: private Slack channels, private or confidential
calendar events, private meetings, and sources added with `--visibility private`.

Who sets it: any writer of the page, local or remote. Who clears it: the owner or the brain operator, on purpose,
on the brain host (an edit through `put_page`, a git edit, or `gbrain repair private-labels`). A remote writer
cannot rewrite a page its write policy hides, so an agent cannot clear a label it cannot see. Clearing widens what
other members and public callers read; do it only on the owner's ask.

### Privacy aliases: `access` and `confidentiality`

`access: private|restricted|confidential` and `confidentiality: confidential|secret|private|restricted` on a page
with no `visibility` read exactly like `visibility: private` (unless the operator turned
`visibility.honor_aliases` off). They exist so imported pages that already carry such a field stay private.

Writers never add them to new pages: write `visibility: private` when a page needs privacy, and nothing otherwise.
`gbrain repair private-labels` previews and clears `access: private` labels that were stamped on ordinary pages, and
keeps `restricted`, `confidential` and `confidentiality` as real restrictions.

### Derived pages and lineage

These rules follow the origin, so nobody writes them by hand:
- an extracted atom, a pinned-question page and a synthesized concept with no `visibility` read as private (their
  origin may be a private transcript);
- an atom whose origin page is private, a concept with a private input, a chronicle event from a private meeting,
  and any page whose `derived_from` names a private page are private whatever their own field says;
- anything derived from a page that names `readable_by` is hidden from every remote caller.

`gbrain repair visibility` stamps the explicit value on derived pages (tighten-only). The owner reads them all.

### `pinned_question`

Pinned-question pages are the owner's own and read as private. The owner reads them; a `--private-pages granted-sources` grant never widens them.

### `readable_by` and folder rules (member access)

`readable_by: [alice-example, group:team-a]` keeps a page to the members and groups it lists; `gbrain access rule
add --prefix <folder>/ --readers <list>` does the same for a folder. This is the boundary between people in a
shared brain, and it binds the owner too: the owner reads such a page only when listed. No grant, hatch or owner
binding relaxes it. Use it for a page that belongs to specific people in a shared brain; a single-user brain needs
none. The page's writers set it; widening a folder rule waits for `gbrain access apply`. A credential bound to a
member with `default` or a federated source as its write source gets it on the pages it creates there (`readable_by: [member:<id>]`),
except the owner's, whose new pages stay shared (`POST /ingest` still refuses both). See
[company brain, Model C](../tutorials/company-brain.md#two-scoping-models-pick-the-one-that-matches-your-shape).

### Fact visibility (`private` | `world`)

Each fact row has its own visibility. `remember` defaults to `world`, except into a private page or under an
explicit private `facts.default_visibility`; extracted facts follow `facts.default_visibility` (private when unset)
and are never wider than their page. Remote `recall` returns private facts to the owner only.

### The owner (`gbrain access owner`)

`gbrain access owner set <member>` names the member who owns the brain; it must be an enabled member
(`gbrain access member add <id>` first). Only the local CLI sets or clears it, and everything lives in the
database, so a repo-less brain works the same. The owner relaxation applies to a credential bound to that member
when it speaks for itself (no audience, or an audience of the owner alone); never to a shared-room audience or an
attested call. `gbrain access owner clear` turns it off.

One owner credential both reads every private page and writes new `default` pages that other members read, so an
owner agent can copy private content into a shared page. A prompt planted in a page that agent reads can ask it to.
Bind only agents you trust with the whole brain as the owner; give every other agent its own member, whose new pages
stay kept to it.

## Related

- [Multi-source brains](multi-source-brains.md): sources and grants.
- [Company brain](../tutorials/company-brain.md): members, groups and `readable_by`.
- [What confines remote callers](../architecture/brains-and-sources.md#what-confines-remote-callers-and-what-does-not).
- [Page anatomy](page-anatomy.md): every frontmatter field.
