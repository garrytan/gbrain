# Owner turns in a shared room

**Say to your agent:** *"When I ask you something in the team chat, do the work with everything you know, and tell me privately about anything the room shouldn't see."*

A shared agent (a Slack, Telegram or Discord bot, a shared OpenClaw or Hermes)
often answers its owner inside a group chat. The owner should get the same
work they would get in a direct message, so gbrain never narrows that read.
What the agent needs is a way to tell which parts of the answer the people in
the room could not have read themselves. A **room** gives it that: the harness
says who is in the chat, gbrain answers at the caller's normal scope, and every
page and fact in the answer carries a `room_access` mark.

A room is a hint, never a filter. Declaring one never refuses, shortens,
reorders or fails a read, and a call that declares no room returns exactly what
it returned before rooms existed.

## Quickstart

1. Check that the server supports rooms: `whoami` returns `features.room: true`.
2. On every call made for a turn in a shared chat, name the people in it:

   ```text
   X-Gbrain-Room: alice-example, group:team-a                 # HTTP header (gbrain serve --http)
   "_meta": { "room": ["alice-example", "group:team-a"] }     # request-level _meta, a sibling of arguments
   ```

   Entries are member ids, `group:<id>` or `guest` (someone who is not a
   member), the same grammar as `readable_by` and `on_behalf_of`.
3. Read each item's mark and the `_meta.room` summary, then write the reply.

## Channels

Prefer `_meta.room` or the `X-Gbrain-Room` header: the harness sets them and
conversation text cannot. A harness that cannot set either may pass a `room`
tool argument, but only after `whoami` shows `features.room` (an older server
rejects or ignores an unknown argument). The argument is removed before the
tool runs, so no handler, cache, retry or stored write ever sees it.

Text in the chat can put words into tool arguments, so an argument can only
add people, never remove them. When the argument names a different room than
the harness did, gbrain marks the answer for everyone either one names and
adds the `room_conflict` notice. Naming a smaller room in an argument changes
nothing else.

## What the marks mean

| `room_access` | Meaning | What the agent does |
|---|---|---|
| `{readable: true}` | everyone in the room could read this item themselves | use it freely in the reply |
| `{readable: false, reason}` | someone in the room could not read it | use it to do the work; keep it out of the reply unless the ask needs it, and offer it in a direct message |
| `{readable: "unknown", reason}` | gbrain could not tell | treat it like `false` |

`readable: true` means exactly what an `on_behalf_of` read for the same room
would return. The reasons for `false`, checked in this order:

| Reason | Why the room could not read it |
|---|---|
| `readers` | the page's `readable_by` leaves out someone in the room |
| `folder_rule` | a folder rule keeps it from someone in the room |
| `labelled_only` | someone in the room reads only pages labelled for them, and this one is not |
| `private_label` | the page is `visibility: private` |
| `derived` | it was built from a page the room cannot read |

When any item is not `true`, the answer carries the `room_above_level`
safety notice, so a model that never sees `_meta` still sees the warning.

`_meta.room` summarizes the call: `principals` (the room as read),
`declared_by` (`harness` or `argument`), `conflict`, `complete`,
`counts` (`items`, `readable`, `above`, `unknown`), `by_reason` and
`above` (each page or fact the room could not read, or that could not be
judged, by `source_id` and `slug`, `page_id` or `fact_id`, with its reason). Hot-memory
facts in `_meta.brain_hot_memory` are marked the same way.

Covered tools: `get_page`, `search`, `query`, `list_pages`, `find_pages`,
`get_chunks`, `get_timeline`, `get_backlinks`, `recall` and `entity`. Every
other tool still runs normally with a room declared; its answer is marked
unknown with reason `op_not_covered`.

## Who may ask

The brain owner's own credential may declare any room without `may_act_for`.
That exemption widens nothing: the owner already reads every page the room
could, the room only adds marks, and a room never changes which pages are
returned. It is also only an exemption for rooms; an `on_behalf_of` audience
from the owner's credential still needs `may_act_for` like anyone else's.

Any other member's credential needs `may_act_for` covering everyone in the
room, because the marks tell it what those people may read. Without it the
answer is unchanged and every item is marked unknown (`not_permitted`). A
connection bound to no member gets unknown marks (`unbound`).

A room describes who will see the answer, not whose turn it is. For a turn
asked by someone other than the owner, the harness names that audience with
`on_behalf_of`, which does narrow the read ([shared agents](../tutorials/company-brain.md#two-scoping-models-pick-the-one-that-matches-your-shape)).

## When marks are unavailable

If the room cannot be judged, the answer is still complete and every item is
marked `{readable: "unknown", reason}`, `_meta.room.complete` is false and the
`room_hints_unavailable` degraded notice explains why:

| Reason | Cause | Fix |
|---|---|---|
| `invalid` | the room was empty or malformed | send a list of member ids, `group:<id>` or `guest` |
| `not_permitted` | the credential's `may_act_for` does not cover the room | the operator widens `may_act_for` |
| `unknown_principal` | the room names a disabled or unknown member or group | fix the name, or add the member |
| `unbound` | the connection is bound to no member | bind the credential to a member |
| `mark_failed`, `deadline` | judging failed or took more than 3 seconds | retry; nothing was changed |
| `op_not_covered` | the tool does not mark its results | none needed |

Some items can be unknown inside a complete answer too: `not_found` (the item
could not be looked up again), `not_identified` (it carries no page or fact
id) and `over_limit` (only the first 2,000 references are judged). When the
marked answer would exceed the response size cap, the unmarked answer is sent
with `_meta.room.complete: false`; treat every item as above the room.

## Keep raw results out of the room's transcript

Marks only help if the owner's raw tool results stay private. Many harnesses
store tool output in the conversation history, and in a group chat that
history may be visible to, or replayed for, everyone in it. A harness that
declares rooms must keep the owner's raw tool results out of any transcript
the room can read, and store only the reply it sent.

## Audit and repo-less brains

Each marked call appends a count-only `room_marked` row to
`~/.gbrain/audit/access-audience-YYYY-Www.jsonl`: how many items were
readable, above or unknown, by reason. It never records the room's names, slugs
or content. Rooms add no setting and no migration, and they work the same on a
repo-less brain, where the readers, folder rules and labels live in the
database.
