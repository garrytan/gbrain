# Job proposals

`gbrain propose` looks at what is already in your brain and lists jobs your agent could take on for you. Each job
says how many things it found, which pages it found them on, and which installed skill (or which gbrain command) does
the job. Nothing is sent anywhere: no model, embedding provider or other service is called, and no key is needed.

```text
$ gbrain propose
Jobs your agent could take on (last 7 days, from what is already in this brain):
1. 2 people are waiting on you for something you promised or a decision you owe.
   Pages: email/launch-follow-up, email/contract-question
   Do it with: gbrain waiting
   Signal: waiting_on_you
2. You owe a reply on 3 email threads.
   Pages: email/intro-acme-example, email/hiring-loop, email/offsite-dates
   Do it with: skill reply-drafter (claude-code-user); or: gbrain loops list --type unanswered_inbound
   Signal: owe_reply
Nothing found for: meeting_prep, repeat_question, bulk_senders.
Answer one: gbrain propose accept|decline <signal>. Agents: MCP propose_jobs and propose_decide.
```

## What it looks for

| Signal | What it finds | Reads |
|---|---|---|
| `waiting_on_you` | People waiting on something you promised, or a decision you owe | open loops (`gbrain waiting`) |
| `owe_reply` | Email threads you owe a reply on | open loops of type `unanswered_inbound` |
| `meeting_prep` | Meetings with the same title at least twice in the window and no prep page (no note whose title contains it, and no non-meeting page linking to it) | calendar pages |
| `repeat_question` | A question you asked in two different agents (for example Claude Code and Codex) | the [conversation archive](conversation-archive.md) |
| `bulk_senders` | Senders of three or more threads, or of promotions, social or forum mail, that you have never written to | email pages |

`--days N` (1 to 90, default 7) sets how far back it looks. Calendar series are counted over four times that window
and the days ahead. Each detector reads a bounded number of rows. The sentences carry counts only: never a name, a
subject, a question or any other page text. Dollar amounts never appear, because no detector reads money from your
own records.

## Which skill does the job

For each job, gbrain asks the [skill resolver](skill-resolver.md) which installed skill fits, using the same word match
as `gbrain skills resolve --text`. It sends a fixed description of the job (for example "reply to email threads I
owe an answer"), never the job's own text, and it runs with skill vectors and the model picker off, whatever your
resolver settings say. When no skill matches, or no skill index is built, the job names the gbrain command that does
it. Every job keeps that command as `fallback_command` in `--json`.

## Saying yes or no

`gbrain propose accept <signal>` or `gbrain propose decline <signal>` records your answer; agents call
`propose_decide` with `{"signal": "...", "decision": "accepted"|"declined"}`. The answer is stored in the
first-session record (`onboarding.first_session` in the database config, on a brain with or without a git
repository) and read back before it is reported: `verified: true` means the store holds it.

## At the start of a session

On a new personal brain, the [first-session suggestion](first-session-suggestion.md) carries the top job you have not
answered yet, once a Google source has finished its first sync. It is one line in that section, worded with counts
only, and it names `gbrain propose` for the pages. It follows the section's own rules: the first 3 sessions within 14
days of setup, and `gbrain onboarding off` (or `onboarding_off`) turns it off with the rest of the section. A job you
declined or accepted is not offered again. Session start runs no detector: the top job is worked out after each Google
sync and each `gbrain propose` run while the suggestion is on, stored with the first-session record, and offered only
while that stored job is at most 3 days old.

## Who can see them

Only the owner of the install: the trusted local CLI, a stdio MCP server bound to no member or to the owner, or a
credential bound to the owner member. Any other connection gets `propose_owner_only` and nothing is read or changed.
Over MCP the jobs read only the sources that connection is granted, and a connection with a trust floor is refused,
because the cited page slugs and counts would show what the floor hides.

`gbrain onboard --propose` prints a pointer here, because `gbrain onboard` plans brain remediation.
