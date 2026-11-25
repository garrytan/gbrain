# Standing rules and the correct tool

When you correct your agent ("no, she's VP of Engineering, never call her the CTO"), the agent can save that once and
stop making the mistake. One `correct` call does three things in a fixed order:

1. It saves your words as a **standing rule**, a small page at `rules/me/<name>` (your own) or `rules/team/<name>`
   (everyone in this brain).
2. It fixes the wrong fact: it replaces it with the right one (`remember` with `replaces`), or withdraws it
   (`forget`) when there is no right one. A withdrawn fact is expired, never purged, so its history stays.
3. It marks the rule active.

Every step is a separate write with its own request id taken from the receipt. If the process stops part way, running
the same call again (same `request_id`) or `gbrain correct resume <receipt>` repeats only the steps that never
committed. Nothing is written twice.

Everything here works on a keyless brain with no git repository, and nothing in it calls a model.

## Saving a correction

From the command line:

```bash
gbrain recall people/alice-example                     # find the wrong fact's id
gbrain correct "Alice-example is VP Engineering; never call her the CTO." \
  --fact-id 42 --corrected-fact "Alice-example is VP Engineering." --entity people/alice-example
```

From an agent, the MCP tool is `correct`:

```json
{"rule": "Alice-example is VP Engineering; never call her the CTO.", "fact_id": "42",
 "corrected_fact": "Alice-example is VP Engineering.", "entity": "people/alice-example"}
```

Leave out `fact_id` to save only the rule (for a mistake no stored fact caused). Add `--question "<q>" --expect a,b
--reject c` (or `checks` over MCP) to give the rule a regression check.

## The receipt

`correct` returns a receipt. Read it again with `gbrain correct status <receipt>` or `correct {"receipt_id": ...}`.
Only the connection that made a receipt can read it, apart from the brain host.

| `state` | What it means |
|---|---|
| `committed` | All three steps are done. |
| `pending` | A step's write was accepted and is still being saved. Read the receipt again. |
| `partial` | A step failed or the process stopped; `step` names it. Run `gbrain correct resume <receipt>`. |
| `proposed` | The rule is saved as proposed and waits for the owner; the fact has not changed. |
| `conflicted` | The rule page changed under the last step, so nothing more was written. |

`effect` says what has taken effect (rule `none`, `proposed` or `active`; fact `unchanged`, `replaced`,
`withdrawn` or `pending`; `standing`: whether agents load it). `next` says what comes next and who does it:
`caller` (the agent), `owner` (you, at your own terminal), or `host_operator` (whoever runs the brain host, when
a remote connection cannot clear the problem itself).

## Who may correct what

- **You, at your own terminal** (`gbrain correct` with no agent marker in the environment): you type a short code,
  and the rule is active and loaded by your agents straight away.
- **Your own agent** (a connection bound to you, or the CLI run by an agent): the rule is active for search at once
  and reads as "you told your agent this". It joins the standing-rules section only after you approve that exact
  revision: `gbrain rules approve <id>@<revision>`. The receipt's `next` names the command.
- **Another member's agent**: the rule stays proposed and the fact unchanged until you approve it. Approving finishes
  the correction: the fact is fixed, then the rule is made active. The approve prompt shows the fact change and whose
  agents the rule applies to, and the code you type covers both. A member's `me` rule loads only for that member's
  agents, never for yours.
- **Guests** cannot correct anything (`correct_guest_refused`).
- Text a tool returned, or something an agent inferred, is refused (`correct_origin_refused`). So is a rule that reads
  like an instruction to override an agent, send data out or handle credentials (`correct_instruction_refused`).

A rule page changes only through `correct` or `gbrain rules`. A remote `put_page` to `rules/...`, or a page
declaring `type: rule` anywhere else, is refused (`rule_owner_only`). A rule's status moves proposed → active →
retired and never back (`rule_transition`). An edit made on the brain host outside these commands drops the rule
from the standing-rules section until you approve the new revision.

## Where agents see the rules

Only confirmed, active rules the caller can read are shown, as labelled data (the user's stated preferences, below the
agent's own instructions and this brain's policy). At most 30 rules and 1,500 characters, your own rules first. Rules
approved in the last 7 days are named at the end.

- `context_pack` with `include_rules: true` adds a `rules` field.
- `gbrain compile-context --include-rules` adds them to a compiled context file (never into a file git tracks).
- The session-start pack adds a standing-rules section only when you switch it on with
  `gbrain config set rules.session_start on`. It is off by default until our cross-harness test shows it helps.

## Managing rules

```bash
gbrain rules list                       # every rule: status, revision, confirmed
gbrain rules show me/<name>             # one rule, and the approve command when it needs one
gbrain rules approve me/<name>@<rev>    # confirm that exact revision (asks for a short code)
gbrain rules retire me/<name>           # stop loading it; a retired rule is never revived
gbrain rules check                      # keyless regression check of confirmed rules
```

`gbrain rules check` searches for each check's question (or the rule's own words) and passes when the rule or the
page it corrects is in the top 5 results, every expected word is there and no rejected word is. `gbrain doctor` runs
the same check as `rules_regression`.

## Errors

### correct_guest_refused
The write source is a guest source. Guests write only guest notes, so tell the user what should be corrected; the
brain's owner saves the rule.

### correct_origin_refused
`content_origin` was `tool_output` or `inferred`. Call `correct` only with the user's own correction; save what a
tool returned with `remember`.

### correct_instruction_refused
The rule reads like an instruction to override an agent, send data out or handle credentials. Rephrase it as the
user's own preference about a fact or a way of working.

### correct_receipt_not_found
No receipt with that id was made by this connection. Use the `receipt_id` `correct` returned to this connection, or
run `gbrain correct status <receipt>` on the brain host.

### rule_exists
A proposed or active rule with the same words already exists. Approve it (`gbrain rules list` shows it) or leave it.

### rule_proposed
The rule is saved and waits for you. Relay the receipt's `next.user_message`; you run
`gbrain rules approve <id>@<revision>` in your own terminal.

### rule_transition
A write tried to move a rule's status backwards, or to a status rules do not have. Save a new rule with `correct`.

### rule_owner_only
A remote write named a rule page outside `correct`. Use `correct`, or ask the owner to run `gbrain rules retire`.

### rule_revision_stale
The revision you approved is not the rule's current one. Run `gbrain rules show <id>` and approve the revision it
shows.
