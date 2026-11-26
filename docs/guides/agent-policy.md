# Agent policy

An agent policy tells your agents when they may act for you outside the brain: send a message, spend money, delete something, sign up for a service, place a call or publish. Agents ask before they act, with the `policy_check` tool or `gbrain policy check`, and get one of four answers:

| Decision | What the agent does |
|---|---|
| `allow` | Goes ahead, still inside its harness's own approvals. |
| `ask` | Asks you first. |
| `deny` | Does not do it. |
| `none` | No policy is set; it uses its own judgment and its harness's approvals. |

The policy is advice. Nothing in gbrain blocks an action: your harness (Claude Code, Codex, gskills' guard) stays the place that enforces. What the policy adds is one place where your rules live, that every agent reads the same way.

## Quick start

```bash
gbrain policy init                                   # the ask-all preset: ask before every outside action
gbrain policy allow spend --amount 60 --currency USD # allow spending up to 60 USD per action
gbrain policy deny send --to new                     # never message someone new
gbrain policy show                                   # print the rules
gbrain policy check spend --amount 25 --currency USD # what an agent would get
```

Each change asks you to type a short code from the terminal, so you see what changes before it applies.

## Commands

| Command | What it does |
|---|---|
| `gbrain policy init [--preset <name>] [--scope owner\|company]` | Starts a policy from a preset (default `ask-all`). |
| `gbrain policy presets` | Lists presets: `ask-all` and `gskills-level-0` to `gskills-level-3`, which match gskills' action levels. Every level still asks before send, spend, delete and publish. |
| `gbrain policy allow\|ask\|deny <verb> [options]` | Adds or replaces one rule. Verbs: send, publish, spend, delete, sign_up, call, book, cancel, dispute, submit, return, use, renew, remind, other. Options: `--amount 60 --currency USD` (or `--amount 60USD`), `--merchant <name>`, `--to self\|household\|known\|new`, `--window per_action\|day\|week\|month`, `--id <rule-id>`, `--note <text>`. |
| `gbrain policy edit` | Opens the rules table in your editor. Needs your own terminal. |
| `gbrain policy show [--check] [--json]` | Prints the rules; `--check` also checks the page parses and is approved. |
| `gbrain policy check <verb> [options] [--json]` | The answer an agent gets, with the rule that decided it. |
| `gbrain policy accept <revision>` | Approves a pending revision (see below). |
| `gbrain policy status [--json]` | Each scope's state and which MCP clients fetched the policy last. |

How rules combine: a rule that names a merchant wins, then a rule with a condition (amount or recipient), then the verb's plain rule. When two rules match at the same level, deny beats ask and ask beats allow. A verb with no rule answers ask, and so does a check that leaves out the merchant, recipient or amount a deny or ask rule depends on. An amount in a currency the rule does not name answers ask. On a shared brain the owner policy and the company policy both apply, and the stricter answer wins; a member, group or guest credential, or an audience of several people, reads only the company policy.

## Budgets

A limit with `--window day`, `week` or `month` is a budget instead of a per-action cap: the amount plus what that window has already used must fit under it. gbrain reads the used part from the [action ledger](action-ledger.md): spends logged as done, plus holds that `policy_reserve` placed and that have not expired. Windows are in UTC and weeks start on Monday. Only actions the caller can read count. A budget gbrain cannot read answers ask.

```bash
gbrain policy allow spend --merchant grocer-example --amount 150 --currency USD --window week
```

`policy_check` returns each budget that applies as advice (`"advice: 40 USD left this week"`), never as an enforced limit, and `requires_approval: true` for spend, cancel, sign_up and dispute whatever the decision. To stop two agents from both spending the last of a budget, an agent calls `policy_reserve` instead of `policy_check`: it checks and holds the amount in one step.

## Who can change it

Only you. An agent often has a shell on the same machine, so a local command is not proof that you ran it. A change applies only when:

- you type the confirmation code at a terminal prompt, in a process that carries no agent marker (such as `CLAUDECODE` or `CODEX_*`), or
- you approve the exact revision in the owner session of `gbrain serve --http` (`POST /admin/api/policy/accept` with `{"scope":"owner","revision":"<revision>"}`).

From an agent session, or with no terminal, the change is saved as a pending revision that changes nothing agents get, and the command prints the `gbrain policy accept <revision>` line for you to run in your own terminal. Remote callers (MCP, HTTP) can read the policy but never write its page. `gbrain config set policy.approved.*` is refused.

A change made any other way, for example by editing the page file, shows as `changed_outside_gbrain`: agents keep getting the last approved revision, and `gbrain doctor` (check `policy_valid`) names the revision to review and accept.

The limit: this is tamper-evident against agents writing through gbrain. It is not protection against someone with direct access to the database or the brain host.

## The brain-first line

`gbrain setup` can add one line to the brain-first block in your agent instructions, telling the agent to call `policy_check` before an outside action. It is off by default. `gbrain config set brain_first.policy_line on` adds it at the next setup or upgrade, and `off` removes it. The line appears only where `policy_check` is reachable: the CLI, the full MCP surface, or the starter surface (through `request_tools`).

## Which tools can my agent call?

The `capabilities` tool answers, for each op name: whether this gbrain build serves it, whether this connection lists it and can call it, and the fix when it cannot. A tool that is callable but not in the tool list says so, with how to call it; it never asks for a new grant.

## Errors

### policy_confirm_required

The change was not applied because this process could not confirm as you: it carries an agent marker (`reason: agent_marker`, the marker is named), has no terminal (`no_terminal`), or the code was not typed (`declined`). Run the command in `fix` in your own terminal, outside the agent session.

### policy_approval_reserved

A reserved setting (`policy.approved.<scope>`, or `brain_first.policy_line` from an agent session) was not changed. Use `gbrain policy` commands, or run `gbrain config set` yourself in your own terminal.

### policy_owner_only

A remote caller tried to write, move or retype the policy page. Change it with `gbrain policy` on the brain host.

### policy_malformed

The policy fence does not parse; the message names the line and column. While it is malformed, agents get the last approved revision, or ask for every verb when nothing was ever approved. `gbrain policy show --check` shows the problem and `gbrain policy edit` fixes it.

### policy_revision_stale

The revision you tried to approve is not the page's current one. `gbrain policy status` shows the pending revision to approve instead.
