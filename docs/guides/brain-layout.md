# A personal brain in one command

`gbrain setup` gives an agent memory. `--shape personal` also gives that memory a
starting shape: a few pages about you that the agent reads, and your existing notes,
searchable from the first session.

```bash
gbrain setup claude-code --shape personal --notes ~/notes
# or
gbrain setup codex --shape personal --notes ~/notes
```

## What it writes

- **Three starter pages**, only when they don't exist yet: `me/facts`, `me/voice` and
  `me/how-i-decide`. Each is an empty form with one line marked "Example (delete me)"
  and `status: stub` in its frontmatter. Nothing about you is invented. Fill them in
  yourself, or tell the agent a fact and it saves it with `gbrain remember`. A re-run
  never overwrites a page.
- **Your notes, read only.** `--notes DIR` imports the markdown in that folder
  (`gbrain import DIR --no-embed`). Setup never writes into the folder. Above 500
  markdown files it prints the import command for the agent to run as its own step,
  so setup stays quick.
- **A short block in the agent's instruction file**, next to the brain-first block
  (`~/.claude/CLAUDE.md` for Claude Code, `$CODEX_HOME/AGENTS.md` for Codex). It tells
  the agent to read those pages, to state facts about you only from `me/facts`, and that
  a `status: stub` page holds no facts yet. `--no-instructions` skips it, and takes it
  out again if an earlier run wrote it.

Then setup checks that keyless search finds one of your notes by its title and prints a
question to try in a new session.

## Without the flag

A brand-new brain set up without `--shape` asks once when a person is at the terminal.
When an agent runs setup (`--json`, or no terminal), the question comes back as the
`brain_shape` decision in the `first_run_decisions` notice, with the exact command for
each answer. Nothing is written until it is answered, `--yes` included.

## Undo

`gbrain setup <harness> --shape none` removes the block. The pages stay; delete them
with `gbrain delete me/facts` (and the others) if you want them gone.

## Paste this to your agent

> Install gbrain and make it my personal brain: run
> `gbrain setup claude-code --shape personal`, and if I have a notes folder, add
> `--notes <that folder>`. Then tell me what it wrote and the question to try.

A company brain (`--shape company`) arrives in a later release. To see one answer
questions today: `gbrain sources demo company-brain`.
