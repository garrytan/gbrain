# A personal or company brain in one command

`gbrain setup` gives an agent memory. `--shape` also gives that memory a starting shape:
a few pages the agent reads, and your existing notes or company docs, searchable from the
first session.

```bash
gbrain setup claude-code --shape personal --notes ~/notes
gbrain setup claude-code --shape company --docs ~/acme-example/docs --transcripts ~/acme-example/calls
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
- **Your call transcripts, read only.** `--transcripts DIR` imports exported call and
  meeting transcripts (`.txt` and `.md` files, from any recorder) into the `company`
  source, one page per file: `company/calls/<date>-<title>`. The date comes from a
  `YYYY-MM-DD` at the start of the file name, else from the first line, else from the
  file's modified day; the title is the rest of a dated file name, else the first line.
  The words are kept as written, except that every credential (API keys, tokens,
  passwords) is replaced by a `<REDACTED:…>` marker before anything is stored, with the
  same redaction the conversation archive uses; the file's path is redacted the same way
  before it is stored or printed. A line that would read as page structure gets a
  leading backslash. The pages are keyword-only (no embedding cost): embedding them waits
  for your approval, with the same hold the conversation archive uses. The facts
  backstop skips them; the scheduled atom extraction still reads them when a model key
  is set, within `cycle.extract_atoms.budget_usd`, and so does event extraction
  (`auto_chronicle`) within its daily limit. Setup's `what leaves this machine` line says
  which of these is on for your brain, or that nothing leaves. Each file is imported once: a re-run from the same folder, or from a folder above it,
  reports it unchanged, and a file you changed since keeps its first page (delete the page to
  import it again). Above 500
  files setup prints the import command instead (`gbrain import DIR --calls --prefix
  company/calls --no-embed --source company`). It needs the company part on this brain,
  so it does not go with `--team`.
- **Who reads the call pages.** They carry no readers of their own, so whoever can read
  the `company` source reads them, and no one else. Setup prints who that is, for example
  `readable by: everyone who can read source company (this brain serves one person)`, or
  on a brain that serves several people, the members the source's access rules allow
  (`gbrain access who-can-read <slug> --source company` shows the same). These are not
  your agent conversations: those go to `conversations/` through the
  [conversation archive](conversation-archive.md), which `--transcripts` never touches.

`--shape both` does both parts.

## The instruction block

A short block in the agent's instruction file, next to the brain-first block
(`~/.claude/CLAUDE.md` for Claude Code, `$CODEX_HOME/AGENTS.md` for Codex). It names the
pages to read for the parts you chose, says to state facts about you only from `me/facts`
and company numbers only from `company/facts`, to add decisions to `company/decisions` as
dated entries, to save company facts with `--source company`, to quote only the dated
lines of a page whose frontmatter says `type: facts` (`me/facts` and `company/facts` do),
and that a `status: stub` page holds no facts yet. `--no-instructions` skips it, and takes it out again if an
earlier run wrote it.

Then setup checks that keyless search finds one of your notes or docs by its title (for
company docs, through default search when the source is in it) and prints a question to
try in a new session. With no docs folder, it suggests `gbrain sources demo company-brain`
to see how a company brain answers. The report also says what the conversation archive is
doing on this brain: on, off, or offered (a brain that may serve several people is only
offered it).

`gbrain doctor` notes a facts page with a fact line that has no date
(`facts_undated_lines`). It names the page and the line numbers, changes nothing, and
asks you for the dates.

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
personal, company, both or skip, then the folders, then just you or a team, then (for a
company brain on this machine) a folder of call transcripts. When an agent
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
> company docs, add `--docs <that folder>`; for exported call transcripts, add
> `--transcripts <that folder>`; if my team will share the company brain, add `--team`. Then tell me what it wrote and the question to try.
