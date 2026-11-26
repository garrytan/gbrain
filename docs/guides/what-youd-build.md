# What you'd build without gbrain

gbrain is a set of parts an agent's memory needs. You can build any one of them yourself, and for some workloads a
simpler setup is as good. This page names each part, what it does, and what the simpler alternative covers, so you
can decide which parts you need. The measured comparisons behind the "as good" claims are on the
[proof page](../proof.md).

**The short version.** If your notes are a few hundred Markdown files and one agent reads them, an agent with `grep`
over the files, or a whole history pasted into the prompt, will answer many questions as well as gbrain. gbrain earns
its keep when several writers share the brain, when some pages must stay hidden from some readers, when the same
person or company appears under several names, when old facts get replaced, and when you need to know that the brain
is healthy.

## Git-backed sync with a writer lock

**What it does.** Your pages live in a git checkout, and the database is built from it. Many writers (your sessions,
sub-agents, cron jobs, hooks) commit and push through one command that takes a lock, commits only the files it names
and merges remote commits without touching anyone else's work. A brain with no repository keeps the database as the
record instead. Guides: [shared checkout](shared-checkout-git.md), [live sync](live-sync.md).

**The simpler alternative.** A folder of Markdown files, or a repository you commit to by hand. That covers one
writer. With several writers on one checkout, committing every changed file, stashing or rebasing sweeps up or
overwrites another writer's half-written files.

## Hybrid search

**What it does.** Keyword search and vector search fused into one ranking, with an optional reranker, typed graph
walks and per-source filters, returning the slug to read next. It works with no API key (keyword only) and gets
better with an embedding key. Guide: [retrieval](../architecture/RETRIEVAL.md), [search modes](search-modes.md).

**The simpler alternative.** Postgres full-text search plus pgvector, fused by rank, which a developer can build in an
afternoon. On LongMemEval gbrain gave a reader 468 right answers of 500 against 445 from that plain hybrid search. An agent with `grep` over the
raw files beat gbrain on very long chat histories (BEAM-10M), so try it before you build anything.

## Facts with provenance

**What it does.** Each fact the brain keeps records where it came from and when, a newer fact supersedes an older one
instead of sitting beside it, and `gbrain forget` withdraws a fact from active memory. Pages from email, web pages
and tool output carry trust labels, so a later session can tell an outside claim from what you said. Guides:
[facts on entities](entity-scoped-facts.md), [memory boundaries](memory-boundaries.md).

**The simpler alternative.** Append notes to a file and let the model sort out which line is newest. That works while
nothing important changes and no outside text is saved. In a planted-claim test, agents with a plain Postgres memory
adopted an attacker's false claim in 10.2% of later sessions, against 2.8% with gbrain's trust labels.

## Access control per page and folder

**What it does.** A page can carry `readable_by` with members or groups, and a folder rule can cover a whole folder. Each
member's credential is bound to that member, and search, reads, links and facts all honour it, so a restricted page
never reaches that member's agent. Guides: [access designations](access-designations.md),
[company brain](../tutorials/company-brain.md).

**The simpler alternative.** Separate folders or separate brains per audience, or filtering results after search.
Separate brains work when audiences never overlap. A memory without per-page permissions leaks: in 100 permission
runs a plain Postgres memory put finance-only text into the agent's context 97 times, and plain files 100 times; gbrain
put it there 0 times.

## Entity resolution and duplicate classes

**What it does.** gbrain links a name in a page to the right person or company page, learns aliases, and lists
everything the brain says about one account. `gbrain dedupe classes` groups pairs of person pages that might be one person
by the evidence for and against, so someone can check a sample before anything is merged. Guides:
[entity recall](entity-recall.md), [duplicate people](duplicate-people.md).

**The simpler alternative.** Search for the name and hope every page spells it the same way. That works for a small
brain with consistent names. It misses a page that uses a nickname or an old company name, and it can't tell you which
two pages are the same person.

## The conversation archive and connectors

**What it does.** The conversation archive writes one redacted page per conversation per day from your agent
harnesses (Claude Code, Codex, OpenClaw, Hermes, Grok). Connectors import ChatGPT and Claude exports and keep syncing
new conversations. Guides: [conversation archive](conversation-archive.md), [chat connectors](chat-connectors.md).

**The simpler alternative.** Keep the raw session logs and paste the relevant ones into the prompt. When one history
fits the reader's window and is asked only a few questions, pasting it scores as well as gbrain's retrieval on
LongMemEval and better on LoCoMo, at several times the reader cost per question.

## Doctor and repair

**What it does.** `gbrain doctor` checks the brain's health and gives each problem a code, a reason and the exact fix.
`gbrain repair` fixes the damage doctor can't, as a preview first, applied only when you pass `--apply`.
Guides: [repair](repair.md), [troubleshooting](troubleshooting.md), [verifying a brain](../GBRAIN_VERIFY.md).

**The simpler alternative.** Rebuild the index from the files when something looks wrong. That works when the files
are the only record and a rebuild is cheap. It doesn't tell you what was wrong, and on a brain whose database holds
things git doesn't (a repository-less brain, timeline history), a rebuild from the files doesn't bring them back.

## The MCP server with OAuth

**What it does.** `gbrain serve --http` serves the brain to remote agents over MCP with OAuth 2.1, scoped tokens, an admin
dashboard and an activity feed, and `gbrain mcp expose` publishes it on your tailnet. Every remote call is treated as
untrusted and checked against the caller's scope and member. Guides: [deploying](../mcp/DEPLOY.md),
[remote MCP](remote-mcp.md), [administration](../mcp/ADMIN.md).

**The simpler alternative.** A local stdio server, or a shared API key in front of a database. A local server covers
one machine. A shared key gives every client the same access, so you can't revoke one agent or keep one agent read-only.

## Evals

**What it does.** gbrain's retrieval and agent behaviour are measured in public in
[gbrain-evals](https://github.com/garrytan/gbrain-evals), against the baselines on this page, with losses reported.
`gbrain eval replay` reruns queries captured on your own brain (capture is off by default) to check a retrieval change. Guides: [eval bench](../eval-bench.md),
[proof page](../proof.md).

**The simpler alternative.** Try a few questions by hand after each change. That catches what you thought to ask. It
doesn't catch a change that quietly makes other answers worse.
