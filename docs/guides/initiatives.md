# Ideas and initiatives

Your brain's project and concept pages describe how things are today. Ideas and
initiatives describe how they are about to change:

- An **idea** is anyone's proposal (`ideas/<slug>`, type `idea`). It never collects
  facts: an idea is not the status quo.
- An **initiative** is time-boxed work (`initiatives/<slug>`, type `initiative`). It
  implements ideas, targets the project and concept pages it changes, and reads
  its Slack channels: facts from those messages and threads land on the
  initiative page.
- When an initiative is **finished as done**, its durable knowledge is **merged**
  into the target pages (facts added, replaced with the old kept as history, or
  withdrawn; new project pages created; a timeline entry linking back), and the
  ideas it implements are closed by the next `ideas` cycle phase.
- Long design material (decision log, FAQ, worked examples) goes in supporting
  pages under the initiative's slug with `type: initiative-doc`
  (`initiatives/<slug>/<doc>`): neither a fact source nor a fact target, listed by
  `initiative_status`.

```
ideas/<slug>  ◀─implements─  initiatives/<slug>  ─targets─▶  projects/… concepts/…
                                    │ slack_channels                (merged on done)
                                    ▼
                          Slack day pages → facts on the initiative
```

**Say to your agent:** *"Create an initiative for the new export format, it implements the CSV-export idea and changes the billing project."*
**Say to your agent:** *"Connect #export-v2 to the export initiative."*
**Say to your agent:** *"The export initiative shipped, finish it and show me the merge plan."*

## Setup

1. Activate the pack (it extends `gbrain-base-v2`):
   ```bash
   gbrain config set schema_pack gbrain-initiatives
   ```
2. Optional: namespace the pages and choose where new projects go.
   ```bash
   gbrain config set initiatives.ideas_prefix acme/ideas/
   gbrain config set initiatives.initiatives_prefix acme/initiatives/
   gbrain config set initiatives.new_project_prefix acme/projects/
   ```
   Path prefixes match anywhere in a slug, so `acme/initiatives/x` is still typed
   `initiative`.
3. Slack (optional). The bot needs `channels:history groups:history channels:read
   groups:read users:read chat:write reactions:write channels:join channels:manage
   groups:write`. One source reads every bound initiative channel; another,
   optional, turns a channel into the ideas intake:
   ```bash
   gbrain sources add initiatives-slack --kind slack --channels-from initiatives
   gbrain sources add ideas-intake --kind slack --channels C0123456789 --mode intake
   ```
   Schedule `gbrain sync --source <id>` (or run autopilot) so they sync.

## Lifecycle over MCP

| Step | Operation |
|---|---|
| Find duplicates / similar work, add an idea | `idea_submit` (`dry_run: true` only checks) |
| List ideas or initiatives | `initiatives_list` |
| Create an initiative | `initiative_start` (title, requirements body, `implements`, `targets`, `tracker`) |
| Bind a Slack channel | `initiative_bind_slack` (the bot must be in the channel) |
| Progress, finish job state | `initiative_status` (`finish_job`, facts with provenance) |
| Record a decision | `remember` with `entity: <initiative slug>` |
| Finish | `finish_initiative` (`done` or `cancelled`; `dry_run` shows the steps) |
| Apply the merge | `initiative_merge_apply` (`skip` item ids, `dry_run`) |

`finish_initiative` queues the `initiative_finish` job: a final Slack sync, the
last facts routed, a closing message in each channel and the bot leaving it
(`initiatives.slack.leave_on_finish`, default true), then for `done` a merge plan
written into the initiative page (`## Merge plan`). The job runs as the brain,
not as the caller, so follow it with `initiative_status` (`finish_job`) rather
than `get_job`. A plan carries facts only as items: a facts table the model
copies into a new page's body is dropped, so a fact is never imported twice. A person reviews it (or edits
the JSON block) and applies it with `initiative_merge_apply`; set
`initiatives.merge.auto_apply true` to apply right away.

Targets: none means the initiative becomes a new project under
`initiatives.new_project_prefix`; a target slug that does not exist is created
as a new project; existing targets receive the merged facts.

## Ideas intake channel

In an intake channel every top-level message is classified; an idea becomes an
`ideas/<slug>` page (the original text, author and permalink kept), and the bot
answers in the thread with similar ideas, initiatives in progress and existing
pages that may already cover it. A near-identical idea counts as support for the
existing one (`votes`). Thread replies become the idea's discussion. When an
initiative implementing the idea starts or finishes, the `ideas` phase replies in
the same thread.

## The `ideas` cycle phase

Runs with the dream cycle (`cycle.ideas.enabled`, default on):

- idea status from initiatives: active implementer → `planned`, done → `implemented`
  (`implemented_by`), only cancelled → back to `open`;
- similar ideas and initiatives linked both ways (`similar:`), above
  `initiatives.ideas.similar_threshold` (default 0.85).

## Config

| Key | Default | Meaning |
|---|---|---|
| `initiatives.source` | `default` | Source holding ideas, initiatives and new projects |
| `initiatives.ideas_prefix` | `ideas/` | Idea slugs |
| `initiatives.initiatives_prefix` | `initiatives/` | Initiative slugs |
| `initiatives.new_project_prefix` | `projects/` | New project pages created by a merge |
| `initiatives.slack.leave_on_finish` | `true` | Post a closing message and leave the channels |
| `initiatives.merge.auto_apply` | `false` | Apply the merge plan without review |
| `initiatives.ideas.similar_threshold` | `0.85` | Similar-idea link threshold |
| `initiatives.ideas.duplicate_threshold` | `0.92` | Duplicate-idea threshold |
| `initiatives.ideas.max_per_cycle` | `200` | Ideas clustered per cycle |
