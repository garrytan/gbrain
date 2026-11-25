# Tutorial: Set up a household brain

One brain for a home: bills, supplies, birthdays, school forms, appointments, returns and store credits, shared with
the people who help run the house, without anyone reading more than they should. Everyone in this tutorial is
invented: Alice and Bob are two parents, Casey helps with the house, and Robin is their child.

**Time:** about 10 minutes. **Cost:** nothing; the household template needs no API key.

## What you get

- **Your agent answers "what needs doing at home?"** from one ranked list (`household_due`): what is overdue, what is
  at risk this week and what is coming up.
- **Each person gets their own key** that reads only what their role allows:

  | Who | Member | Reads | Writes |
  |---|---|---|---|
  | Alice, the owner | `alice-example` | everything | everything |
  | Bob, the other parent | `adult-b` | every household record | household records |
  | Casey, the helper | `helper` | supplies, appointments, birthdays, deadlines | nothing |
  | The family group chat | `family-chat` | the same as the helper | nothing |

  Bills, credits, returns and **everything about a child** stay with the adults. The full table is in
  [Household records](../guides/household.md#who-can-read-what).
- **Robin gets no member and no key.** A child is a page marked `household_role: child`, never a login.
- **Your agent never buys, pays, books, calls or sends anything** without your yes.

## Step 1: Preview

```bash
gbrain setup claude-code --shape household --owner alice-example
```

(Use `codex` instead of `claude-code` for Codex.) Nothing is written yet. The preview lists every step as the exact
`gbrain access` and `gbrain auth` command it stands for: the members, the household groups (`household-adults`,
`household-helpers`, `household-chats`), one folder rule per household folder, and one key per person. Every rule
names you, the owner, so none of them can lock you out.

Your household is shaped differently? Name its people with `--household-members`:

```bash
# A single parent: just you, no other keys
gbrain setup claude-code --shape household --owner alice-example --household-members none
# Three adults and no helper
gbrain setup claude-code --shape household --owner alice-example --household-members adult:bob-example,adult:dana-example
```

Roles are `adult`, `helper` and `chat`. There is no `child` role on purpose.

## Step 2: Apply

```bash
gbrain setup claude-code --shape household --owner alice-example --yes
```

Setup connects the agent, applies every step, and adds a household block to the agent's instructions: call
`household_due` before answering what needs doing at home, record what you say was done with `household_mark`, and
never act without your yes.

Each key goes to its own file, readable only by you (mode 0600), under your gbrain folder, for example
`~/.gbrain/member-keys/helper.key`. **Setup never prints a key.** Giving a key to its person is your own step: move
the file to a private place they choose, such as a password manager, never a chat message or an email. To let them
connect from their own machine, publish your brain over HTTP ([remote MCP](../guides/remote-mcp.md)) and give them
the address with their key.

## Step 3: Check who reads what

```bash
gbrain setup claude-code --shape household --status
```

This prints the run's receipt (every step, and when each key was issued and written to its file, never the key
itself) and a proof for each person: their key is read from its file and used the way their agent would use it, and
the records it reads are compared with the records the placement table says they should read. Every line should end
`ok`. To look at one key's grant, run `gbrain access check --token member-helper`.

Try it: add a bill and a supply, then ask your agent "what needs doing at home this week?".

```bash
gbrain household add bill --title "Water" --due 2026-12-03 --recurs monthly --amount 60 USD
gbrain household add supply --title "Coffee beans" --cadence 14d --last-done 2026-11-20
gbrain household add deadline --title "Field trip form" --due 2026-12-02 --school --about people/robin-example --child
```

The field trip form is about Robin, so it stays with the adults even though deadlines are usually shared.

## If a run stops

Every step is safe to run again. A run that stopped prints its receipt id; finish it with:

```bash
gbrain setup claude-code --shape household --resume <receipt id> --yes
```

The resume runs only the steps that did not finish, for the same harness, brain and source; a receipt written for
another harness or source is refused (`setup_receipt_target_mismatch`). If a key was issued but never written to its
file (the run stopped in between), the resume will not quietly issue a second one: it says so, and you revoke the
first with `gbrain auth revoke member-<id>` before resuming.

## What it changes on your brain

- On a brain with a git checkout the folder rules go to `.gbrain/access.yml` and are committed; on a brain without
  one (the default keyless install) they go to the database.
- The brain is marked as serving several people (`access.serves = several`), and every existing household record gets
  its readers recomputed (`gbrain household replace`).
- A key you made before that is bound to no person no longer reads the household folders. The preview lists each one
  with the `gbrain auth rescope` command that binds it to you; setup never rebinds a key on its own.
- A folder rule you wrote yourself on a household folder is never overwritten: the preview marks it BLOCKED and names
  the command that changes it.
