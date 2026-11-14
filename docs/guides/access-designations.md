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
  sub-agents included, with `gbrain auth rescope --token <name> --member <owner>`. A Claude Code or Codex install
  only the owner uses: `gbrain setup <claude-code|codex> --stdio-member <owner>`, which binds that harness's stdio
  entry on that machine and nothing else (PGLite or Postgres); for a harness several people talk to, one key per
  person over `gbrain serve --http` (`gbrain auth create <name> --member <id>`). On a single-user brain this is how the owner's own
  agent reads the whole brain.
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
| fact `visibility: private` | reads | reads | hidden | hidden | hidden |

"Hidden" means the same `not_found` a missing page gets, on every read path (get_page, search, query, recall, lists,
links, timelines, versions). The owner reads through `get_page`, `search`, `query`, `recall` and the other page
reads in every source its grant reads; the owner's source grant still bounds which sources those are. It also gets
private facts from `recall`, the `query` facts arm, `think` trajectories, hot memory, `delta` and `context_pack` hot
facts, except a fact taken from a page it cannot read. Facts on `entity` and `context_pack` cards stay world-only for
every remote caller, the owner included.

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
keeps `restricted`, `confidential` and `confidentiality` as real restrictions
([how to run and undo it](repair.md#private-labels-over-stamped-access-private)).

#### Unrecognized label values

Any other value of `access` or `confidentiality` is ignored: `access: personal`, a confidentiality value naming a
health record, or free text such as `access: "PRIVATE - do not share"` makes nothing private. A page that carries one
and no `visibility` reads like an unlabelled page: every remote caller of its source can read it (unless `readable_by`
or a folder rule limits it), and on a source with a git checkout the label does not keep it out of git, so it can be
committed and pushed to the brain's git remote. gbrain does not add values to the lists or rewrite the label.

Instead it says so. A `put_page`, `gbrain import` or `gbrain sync` that stores such a page carries one
`privacy_label_ignored` safety notice: it names the key and the value (an import or sync counts pages by value and names
no page), leaves out the git sentence on a repo-less source, and its fix asks the user before adding
`visibility: private`. `gbrain doctor --only privacy_label_ignored` counts the stored pages by value: a value containing
private, confidential, secret, restricted, personal, health or therapy (any case) is a warning, any other value is
information, and the fix is the read-only listing `gbrain list --where <key>=<value> --json`. To keep such a page private,
add `visibility: private` to its frontmatter.

### Derived pages and lineage

These rules follow the origin, so nobody writes them by hand:
- an extracted atom, a pinned-question page and a synthesized concept with no `visibility` read as private (their
  origin may be a private transcript);
- an atom whose origin page is private (also after a rename moved that page), a concept with a private input or an
  input atom whose origin is private, a chronicle event from a private meeting,
  and any page whose `derived_from` names a private page are private whatever their own field says;
- anything derived from a page that names `readable_by` or sits under a folder or page rule is hidden from every
  remote caller, except a credential bound to the owner: the owner reads a derived page or a fact when it reads every
  origin of it (a folder rule kept to the owner, or readers that list the owner). Three operator settings change this,
  and all are off by default. A raw-only rule does not hide what is derived from its pages, an audience member's own member
  page reads to the owner as if it named the owner, and `access.members_read_lineage` gives every member the owner's
  rule (all below).

`gbrain repair visibility` stamps the explicit value on derived pages (tighten-only). The owner reads them all.

When you delete a page that keeps others private, gbrain gives each page whose only privacy came from it its own
`visibility: private` label, so it stays hidden once the deleted page's row is gone (a page that names readers keeps its
`readable_by` and gets the label too, so its listed readers don't gain it). The label stays after that: if you restore the deleted page and later make it world, the pages derived from it
stay private until the owner relabels them.

A file removed with `git rm` outside gbrain is covered only from the next cycle: the next sync soft-deletes its page and
the cycle's purge labels the derived pages before it removes any row. If a label cannot be written, or a page derived from it is
itself soft-deleted (a restore would bring it back unlabelled), the purge keeps the deleted page until that is resolved and
`gbrain doctor` names it as `derived_origin_parked`, with the page that blocks it.

### `pinned_question`

Pinned-question pages are the owner's own and read as private. The owner reads them; a `--private-pages granted-sources` grant never widens them.

### `readable_by` and folder rules (member access)

`readable_by: [alice-example, group:team-a]` keeps a page to the members and groups it lists; `gbrain access rule
add --prefix <folder>/ --readers <list>` does the same for a folder, and `--slug <page>` for exactly one page (a page
at the source root, or one whose file left git, which a `visibility` edit cannot reach; upgrade every host that shares
the brain first, because an older one stops syncing a git-backed source that holds a page rule). This is the boundary between people in a
shared brain, and it binds the owner too: the owner reads such a page only when listed, unless the brain operator
turns on the owner opt-in (below). No grant or hatch relaxes it. Use it for a page that belongs to specific people in a shared brain; a single-user brain needs
none. The page's writers set it; on an existing page the brain host sets or removes it with
`gbrain repair visibility --slug <page> --readers <list>` (or `--slugs-file`), which keeps the page's trust tier and
changes only that line ([how](repair.md)). Widening a folder rule waits for `gbrain access apply`. On a git-canonical
source, a fact held for an entity that has no page yet sits on the holding page of the entity's folder
(`<folder>/memory/unattributed`), which the folder's rules cover; a new rule's preview lists the held facts it would move
there (`held_facts_moving`) and its apply moves them (`held_facts` in the result) ([details](git-canonical.md#how-writes-reach-a-strict-source)). A credential bound to a
member with `default` or a federated source as its write source gets it on the pages it creates there (`readable_by: [member:<id>]`),
except the owner's, whose new pages stay shared (`POST /ingest` still refuses both). See
[company brain, Model C](../tutorials/company-brain.md#two-scoping-models-pick-the-one-that-matches-your-shape).

**Raw-only rules.** `gbrain access rule add --prefix transcripts/ --readers alice-example --raw-only` (in
`access.yml`, `covers_derived: false` on the rule) keeps the pages under `transcripts/` to their readers, but not the
pages and facts derived from them: an atom, a summary, a synthesized concept, a chronicle event or a fact made from a
raw-only page is read by whoever reads that derived page. Use it for raw material such as call transcripts, whose
summaries are meant to be shared. Never use it for a folder whose content is itself the secret. A summary of a
raw-only page carries what the page says, and the facts extracted from it are readable like any other derived page,
so the facts pulled out of a fenced transcript are not fenced. A page's own `readable_by` still hides what is derived from it, and a page
that another covering rule also matches stays covered. Every rule written before this existed covers derived pages and
keeps its digest. Making a rule raw-only widens access, so it waits for `gbrain access apply` (preview, then
`--expect <plan_hash>`); making it covering again (the same command without `--raw-only`) applies at once. Doctor's
`access_raw_only_rules` lists every raw-only rule, and `who-can-read` says when a page's lineage is open. Works the same
for rules in the database (a repo-less brain) and in `access.yml`.

### Fact visibility (`private` | `world`)

Each fact row has its own visibility. `remember` defaults to `world`, except into a private page or under an
explicit private `facts.default_visibility`. A remote credential bound to a member saves `private` on its own member
page (`memory/members/<member>`) unless the call passes `share: true`, and its `visibility: "world"` is refused; it
withdraws only facts on that page, and the brain host withdraws the rest (`gbrain forget <id>`). The owner's own
credential (or a stdio server started with `--stdio-member <owner>`), speaking for itself (no audience, not a
subagent job, no slug fence), saves like a credential bound to no member: shared on the subject's page, or `private` on its member page when it passes `visibility: "private"` or the
page or `facts.default_visibility` keeps facts private (the reply names the `page` and `visibility`; an explicit
`visibility: "world"` onto a page whose facts are kept private is refused, `share_target_restricted`), and its
`forget` withdraws a shared fact it reads, and a private fact it reads on a page its credential can write (one the brain
host saved with `visibility: "private"`, or one on a page whose `readable_by` names the owner). A fact on a `visibility: private` page,
on a page whose readers leave the owner out (even with `reads-restricted on`) or on another member's page stays with the brain host, and one the owner confirmed or curated files a `forget_requires_owner`
proposal instead, as for a shared fact. The trade-off: an owner agent that follows a planted instruction can share a fact
without passing any flag, so pass `visibility: "private"` for a fact that must stay with the owner. Extracted facts follow `facts.default_visibility` (private when unset)
and are never wider than their page. Remote fact reads return private facts to the owner only.

### The owner (`gbrain access owner`)

`gbrain access owner set <member>` names the member who owns the brain; it must be an enabled member
(`gbrain access member add <id>` first). Only the local CLI sets or clears it, and everything lives in the
database, so a repo-less brain works the same. The owner relaxation applies to a credential bound to that member
when it speaks for itself (no audience, or an audience of the owner alone); never to a shared-room audience or an
attested call. `gbrain access owner clear` turns it off.

**The owner opt-in.** `gbrain access owner reads-restricted on` (config `access.owner_reads_restricted`, off by
default and unchanged on upgrade) lets the owner's credentials read the pages that `readable_by` lists, folder rules
and page rules keep to other members, and their derived pages and facts, on every read path: HTTP tokens, OAuth
clients, a stdio server bound to the owner, and `--as <owner>`. It never opens another member's own member page
(`memory/members/<id>`), its derived pages or its facts, never widens a write (the owner still writes only the pages
its readers and rules name), and changes nothing any other caller reads. Only the brain operator on the brain host
sets it; a remote caller is refused. While it is on, `gbrain access check` and `gbrain access who-can-read` show the
owner among the readers, every remote caller's `whoami` says so, and doctor reports `access_owner_reads_restricted`.
`gbrain access owner reads-restricted off` is the undo. Turn it on only when the members agree that the owner reads
what is kept to them, for example a brain where the members are the owner's own groups and assistants.

One owner credential both reads every private page and writes new `default` pages that other members read, so an
owner agent can copy private content into a shared page. A prompt planted in a page that agent reads can ask it to.
Bind only agents you trust with the whole brain as the owner; give every other agent its own member, whose new pages
stay kept to it.

### Audience members (`gbrain access member kind`)

A member can stand for a group chat or a shared assistant rather than a person. `gbrain access member kind <id>
audience` (or `gbrain access member add <id> --kind audience`) marks it; `gbrain access member kind <id> person` is the
undo. The owner then reads that member's own member page (`memory/members/<id>`), its older versions, its derived
pages and its facts as if the page named the owner, with or without the owner opt-in; folder rules still apply unless
the opt-in is on. Only that page: a page that lists the audience in `readable_by` stays under the usual rules (the
owner opt-in opens it), and a person member's member page stays closed to the owner. Nothing changes for any other
caller, and no write widens. Only the brain operator on the brain host sets a kind; a remote caller is refused
(`permission_denied`). `gbrain access member list` marks each audience member, `who-can-read` lists the owner on such a
page, and doctor's `access_audience_members` lists the audience members.

### Members read lineage (`gbrain access members-read-lineage`)

`gbrain access members-read-lineage on` (config `access.members_read_lineage`, off by default and unchanged on
upgrade) gives every member's credential the owner's lineage rule: a member speaking for itself (no audience, or an
audience of that one member) reads a derived page or a fact when it reads every origin of it, on every read path and
in `--as <member>`. Summaries of a page then reach everyone that page lists, so turn it on only when that is what the
members expect. It never applies to an audience of several members, a group or a guest, an attested call, or an unbound
credential (an unbound `granted_sources` token included); a member-bound `granted_sources` token reads with its
member's lineage. It never widens a write, and leaves the owner opt-in to the owner. Only the brain
operator on the brain host sets it; a remote caller is refused. While it is on, every remote caller's `whoami` says so
(`members_read_lineage`), `gbrain access check` reports it, `who-can-read` names it on pages it opens, and doctor
reports `access_members_read_lineage`. `gbrain access members-read-lineage off` is the undo.

### Labelled-only members (`gbrain access member labelled-only`)

Some credentials should see only what someone deliberately labelled for them: a group chat bot, a shared assistant, an
audience of several people. `gbrain access member labelled-only <id> on` marks a member that way (off by default and
unchanged on upgrade; `off` is the undo). Every token, OAuth client and stdio binding of that member then reads only
pages that name it: its id or one of its groups in `readable_by`, or a folder or page rule that lists them. A page with
no label, which its source grant would otherwise open, is hidden on every read path, `--as <member>` and the enforced
member CLI included. So is every derived page and fact that names nobody (summaries, atoms, chronicle events,
`derived_from` pages): they fail closed. With `access.members_read_lineage` on, a derived page or fact passes only when it
has at least one origin and every origin names the member; one unlabelled origin keeps it hidden. An older version
counts only if that version itself named the member or a rule over the page lists it, so adding `readable_by` to a
page does not open its unlabelled history. The member's own memory stays readable: facts on its own member page (the
ones its `remember` calls saved) pass with lineage on or off. Under a shared agent's audience, the label test uses the
audience's identities, not the bound member's, so a page must name someone in the audience. An attested read for a
labelled-only person that names sources would run as the scope, with no member identity and so without the grant, so it
is refused (`permission_denied`); leave the sources out to read as the person.

The grant lives on the member, not on one credential, so a second key for the same member cannot forget it. Writes
follow the same rule: the member cannot update a page it cannot read, and a page it creates must name it
(`access_labelled_only_unnamed`; add `readable_by: [<member>]` or ask for a rule over the folder). A `put_page` to an
existing slug the member cannot read answers `page_not_found`, and to a new slug `access_labelled_only_unnamed`, the same
existence pattern pages with readers already have. It never applies to the owner, even if the flag is stored on the
owner's row: setting it there, or naming a labelled-only member the owner, is refused with exit 3
(`access_labelled_only_owner`) and asks the user. Only the brain operator on the brain host sets it; a remote caller is
refused (`permission_denied`). `gbrain access member list` and `gbrain access check` show it, `who-can-read` notes
which labelled-only members a page leaves out, and doctor's `access_labelled_only_members` lists them. An older gbrain
binary sharing the same database ignores the grant, so upgrade every binary that serves the brain before turning it on.

### Pages every member's key can read

On a brain that serves several people, a key bound to a member reads a page with no label like any other key: the
binding says who is asking, and only labels decide what that person reads. So a chat export or mail import loaded
before anyone named its readers is open to every member's key, and so are the facts drawn from it. gbrain counts those
pages, read-only, wherever you set up or check such a brain: the `gbrain access serves several` preview and receipt
(also shown by `gbrain setup <harness> --serves several`), `gbrain access serves`, doctor's `open_shared_pages` and
`gbrain post-upgrade`. Each shows how many members' keys read them ("the keys of 2 of 3 members"; the owner and
labelled-only members are never counted), the top folders, and the commands that close them, with the owner already in
every reader list:

- DMs, chat and mail: keep members to labelled pages (`gbrain access serves several --members <ids> --labelled-only`
  or `gbrain access member labelled-only <id> on`), then name each page set's readers with
  `gbrain repair visibility --source <id> --slugs-file <file> --readers <owner>,<list>` (preview, then
  `--apply --expect <hash>`). A folder rule can't do this, because one chats/ folder holds DMs between different pairs.
- A folder its readers share: `gbrain access rule add --prefix meetings/ --readers <owner>,<list> --source <id>`.
- New pages: `readable_by: [<owner>, <list>]` in their frontmatter.

The count never depends on who runs it, changes nothing, and never changes an exit code. Doctor warns while DM, chat,
conversation or mail pages are open and reports other open folders as information, since a team may share them on
purpose. A count that fails prints "count unknown" with `gbrain doctor --only open_shared_pages --json` to retry, and
setup carries on. A one-person brain, or one with `access.serves` set to `one`, runs no count, and
`gbrain access serves --no-open-pages` skips it. `--labelled-only` is
opt-in and never applies to the owner: with the owner in the roster the run is BLOCKED before anything is written.

## Related

- [Multi-source brains](multi-source-brains.md): sources and grants.
- [Company brain](../tutorials/company-brain.md): members, groups and `readable_by`.
- [What confines remote callers](../architecture/brains-and-sources.md#what-confines-remote-callers-and-what-does-not).
- [Page anatomy](page-anatomy.md): every frontmatter field.
