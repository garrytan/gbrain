# A personal or company brain in one command

`gbrain setup` gives an agent memory. `--shape` also gives that memory a starting shape:
a few pages the agent reads, and your existing notes or company docs, searchable from the
first session.

```bash
gbrain setup claude-code --shape personal --notes ~/notes
gbrain setup claude-code --shape company --docs ~/acme-example/docs
gbrain setup claude-code --shape both --notes ~/notes --docs ~/acme-example/docs
# Codex: the same with gbrain setup codex
```

## Personal: what it writes

- **Three starter pages**, only when they don't exist yet: `me/facts`, `me/voice` and
  `me/how-i-decide`. Each is an empty form with one line marked "Example (delete me)"
  and `status: stub` in its frontmatter. Nothing about you is invented. Fill them in
  yourself, or tell the agent a fact and it saves it with `gbrain remember`. A re-run
  never overwrites a page.
- **Your notes, read only.** `--notes DIR` imports the markdown in that folder
  (`gbrain import DIR --no-embed`). Setup never writes into the folder. Above 500
  markdown files it prints the import command for the agent to run as its own step,
  so setup stays quick.

## Company: what it writes

- **A `company` source** in the same brain, kept in a folder gbrain owns next to the
  brain's own content (never your docs folder). When the brain serves one person it joins
  default search, so a question that names no source finds company pages too. When the
  brain may serve several people (`gbrain access serves` says several, or
  `brain.audience` is `shared`), it stays out of default search and setup asks you first:
  `gbrain sources federate company` puts it in. If that folder already exists and is not
  an empty folder, setup leaves it alone, keeps the company lines out of the instruction
  block and asks you to move it before you run setup again.
- **Six starter pages** in that source, only when they don't exist yet: `company/facts`
  (numbers agents may quote, each dated with where it came from), `company/decisions`
  (a dated log: what, why, who, what would make you revisit it), `company/pricing`, and
  index pages `company/customers`, `company/calls` and `company/playbooks`. Each is an
  empty form marked `status: stub`.
- **Your company docs, read only.** `--docs DIR` imports that folder into the `company`
  source the same way `--notes` does, with the same 500-file limit.

`--shape both` does both parts.

## The instruction block

A short block in the agent's instruction file, next to the brain-first block
(`~/.claude/CLAUDE.md` for Claude Code, `$CODEX_HOME/AGENTS.md` for Codex). It names the
pages to read for the parts you chose, says to state facts about you only from `me/facts`
and company numbers only from `company/facts`, to add decisions to `company/decisions` as
dated entries, to save company facts with `--source company`, and that a `status: stub`
page holds no facts yet. `--no-instructions` skips it, and takes it out again if an
earlier run wrote it.

Then setup checks that keyless search finds one of your notes or docs by its title (for
company docs, through default search when the source is in it) and prints a question to
try in a new session. With no docs folder, it suggests `gbrain sources demo company-brain`
to see how a company brain answers.

## A team company brain

A company brain your team shares belongs on its own brain, so teammates never reach the
personal pages on your laptop. `--team` (with `--shape company` or `both`) creates
nothing for the company part. It writes the personal part if you asked for it, and tells
you where the shared brain lives:

- **Hosted:** a workspace at [gbrain.io](https://gbrain.io) (`gbrainio workspace new`),
  which teammates join by invite.
- **Self-hosted:** a Postgres brain, with `gbrain access serves several` naming who it
  serves.

Then connect your harness to the shared brain as well. Pages only some teammates may read
use `readable_by` in their frontmatter, or `gbrain access rule add --prefix <folder>/` for
a whole folder. A company source you set up alone with `--solo` (the default) stays on
this brain; moving it to a shared brain later is a separate step.

## Without the flag

A brand-new brain set up without `--shape` asks once when a person is at the terminal:
personal, company, both or skip, then the folders, then just you or a team. When an agent
runs setup (`--json`, or no terminal), the question comes back as the `brain_shape`
decision in the `first_run_decisions` notice, with the exact command for each answer.
Nothing is written until it is answered, `--yes` included.

## Undo

`gbrain setup <harness> --shape none` removes the block. The pages and the `company`
source stay; delete pages with `gbrain delete <slug>` (company ones with
`--source company`) if you want them gone.

## Paste this to your agent

> Install gbrain and give it a shape: run `gbrain setup claude-code --shape personal`
> (or `company`, or `both`). If I have a notes folder, add `--notes <that folder>`; for
> company docs, add `--docs <that folder>`; if my team will share the company brain, add
> `--team`. Then tell me what it wrote and the question to try.
