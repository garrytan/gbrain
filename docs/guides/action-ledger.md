# Action ledger

The action ledger records what your agents did for you outside the brain: a message sent, a subscription cancelled, a bill paid, a sign-up. Each entry says what was done, what it cost or saved, and whether there is evidence. gbrain adds up the totals itself, so a weekly summary never depends on a model doing arithmetic.

## Quick start

```bash
gbrain ledger                         # totals for the last 30 days
gbrain ledger --since 7d --verb spend # one verb, one week
gbrain ledger add cancel --summary "Cancelled the acme-example trial" --saved 12 --currency USD --period monthly --estimated
gbrain ledger digest --week --save    # the week as text, kept as a private page
```

Agents log actions with the `log_action` tool after they act, and read totals with the `ledger` tool.

## What an entry holds

Each action is a private page at `actions/YYYY/MM/<id>` (type `agent_action`). Its fields are fixed, and gbrain refuses an entry with a field it does not know (`action_invalid`):

| Field | Meaning |
|---|---|
| `action` | The verb (the same verbs as the [agent policy](agent-policy.md)), status, time, a summary of at most 200 characters, the counterparty, the harness and the actor. gbrain records the actor from the connection; a caller cannot set it. |
| `money` | Currency, `spent`, `saved` with `saved_period` (`one_time`, `monthly` or `yearly`; never converted to a yearly figure) and `estimated`. |
| `minutes_saved` | An estimate. It is stored but never added up or shown in a total. |
| `evidence` | Refs to what shows the action happened: a page slug, or a URL. |
| `approval` | Who approved it (`owner`, `policy` or `none`), the policy rule and its revision. |
| `claim_basis` | Set by gbrain: `evidenced` when an evidence ref is a page the writer can read, `user_confirmed` after `gbrain ledger confirm`, otherwise `estimated`. |

"Evidenced" means a readable page backs the entry. gbrain checks that the page exists and that the writer can read it the ordinary way, not that the page shows the amount. A URL alone is not evidence gbrain can read.

An amount logged as done needs evidence gbrain can read, or `estimated: true`; otherwise it is refused (`money_unevidenced`).

Statuses move forward only: proposed, then approved, then done, failed or cancelled. A done action can become reversed, and is never edited. To correct one, log a new action with `supersedes` set to the old `action_id`; once the correction is done, totals count only the correction. A correction that is still proposed, or that failed or was cancelled, leaves the old action counted. A correction that was done and then reversed still replaces the old action, and counts nothing itself.

## Who reads what

The owner, local commands and the owner's own agents read every action. A member's actions are labelled readable by that member and the owner, so a member reads its own actions and their totals. A guest, a group or an audience of several people reads none. No caller sees a count of actions it cannot read. Remote callers record actions only through `log_action` and `policy_reserve`; a direct page write to an action page is refused (`ledger_log_action_only`). The ledger lives in the `default` source, so a connection whose write grant is another source records nothing and gets `permission_denied`, and a connection that cannot read `default` reads no actions.

## Budget holds

`policy_reserve` checks the [agent policy](agent-policy.md#budgets), including its day, week and month budgets, and holds the amount for 24 hours in one step, so two agents cannot both be allowed the last of a budget. It returns the `policy_check` answer and a reservation. After acting, the agent calls `log_action` with the reservation's `action_id`, `status: "done"` and the amount it spent, which settles the hold; a settle with no amount records the held amount as an estimate. A live hold counts toward every budget window until it is settled, even one that started after the hold was made, and a settled hold's spend counts in the window it was settled in. A hold that expires without a result counts toward nothing, cannot be settled (log the spend as a new action), and is listed in the weekly digest as unconfirmed. A deny holds nothing. A retry with the same `request_id` returns the same reservation and the answer it first got; a retry that changed the call is refused (`idempotency_conflict`).

A budget counts the actions its caller can read: a member's own, or every action for the owner. A caller that reads no actions, such as a guest, gets `ask` on every budget.

Budgets are advice. The harness, for example gskills' guard, stays the place that enforces a money cap.

## Commands

| Command | What it does |
|---|---|
| `gbrain ledger [--since 30d] [--verb <verb>] [--counterparty <name>] [--json]` | Totals: spent and saved per currency (`--since` reaches back at most 3660 days), split into with evidence, confirmed by you and estimated; counts by verb and counterparty; live and expired holds. |
| `gbrain ledger add <verb> --summary <text> [options]` | Records an action yourself. Options: `--spent <n>` or `--saved <n> --period one_time\|monthly\|yearly`, `--currency USD`, `--estimated`, `--evidence <slug>` (repeatable), `--counterparty <name>`, `--status`, `--at <iso>`. |
| `gbrain ledger confirm <action_id>` | Marks a done action's amounts as confirmed by you. Runs only in your own terminal, never from an agent session. |
| `gbrain ledger digest --week [--save]` | The last 7 days as text, with no model call; `--save` keeps it as a private page under `actions/weekly/`. |

## Repo-less brains

The ledger works the same on a brain with no git repository: entries are pages in the database, and each change keeps a saved version.

## Errors

### action_invalid

The entry did not have the `agent_action` shape: an unknown field, a bad status, verb, amount or currency, or a page outside `actions/YYYY/MM/<id>`. Fix the field the error names and call again with the same `request_id`.

### action_not_found

The `action_id` names no action this caller logged or can read. Use the `action_id` that `log_action` or `policy_reserve` returned.

### action_transition_invalid

The action cannot move to that status. A done action is never edited, and a failed, cancelled or reversed one is final. Log a new action with `supersedes`.

### money_unevidenced

An amount was logged as done with no readable evidence and without `estimated: true`. Add the slug of a saved page that shows it, or mark it estimated.

### ledger_log_action_only

A remote caller tried to write an action page directly. Use `log_action` or `policy_reserve`.

### ledger_scan_too_large

The window holds more actions you can read than one read totals (5,000), or more than 50,000 actions in all. Other people's actions never count toward the 5,000. The answer has `state: partial`, no totals, and the narrower call to make instead.

### ledger_busy

Another reservation was being checked, or an earlier action was still being written. Retry `policy_reserve` in a few seconds with the same `request_id`. A running write whose writer stopped (its claim expired) is left to recovery and never holds up a reservation; a queued write still does, since it may commit. A `log_action` or `policy_reserve` call that answers `write_pending` names the `request_id` to retry with, including one gbrain generated.

### ledger_confirm_required

`gbrain ledger confirm` ran from an agent session or with no terminal. Run it yourself in your own terminal.
