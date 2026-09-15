# Pre-commit hook for brain repos

`gbrain frontmatter install-hook` installs a git pre-commit hook in your
brain source's repo that runs `gbrain frontmatter validate` against staged
`.md` and `.mdx` files. Malformed frontmatter blocks the commit. Bypass with
`git commit --no-verify`.

## What the hook catches

The same eight validation classes the `frontmatter-guard` skill and
`gbrain doctor`'s `frontmatter_integrity` subcheck report:

| Code              | What it catches                                                     |
|-------------------|---------------------------------------------------------------------|
| `MISSING_OPEN`    | File doesn't start with `---`                                       |
| `MISSING_CLOSE`   | No closing `---` before first heading                               |
| `YAML_PARSE`      | YAML failed to parse (syntax or structure)                          |
| `SLUG_MISMATCH`   | `slug:` in frontmatter doesn't match path-derived slug              |
| `NULL_BYTES`      | Binary corruption (`\x00`) anywhere in the content                  |
| `NESTED_QUOTES`   | `title: "outer "inner" outer"` shape that breaks YAML               |
| `NON_STRING_FIELD` | `title`/`type`/`slug` is an unquoted non-string scalar (`title: 123`) |
| `EMPTY_FRONTMATTER` | `---` ... `---` with nothing meaningful between                   |

## Install

For all registered sources inside a git repo (the source's own repo, or a
subdirectory of a host repo — the same shapes `gbrain sync` accepts):

```bash
gbrain frontmatter install-hook
```

For one source:

```bash
gbrain frontmatter install-hook --source <id>
```

For force-overwrite of an existing pre-commit hook (writes a `.bak`):

```bash
gbrain frontmatter install-hook --force
```

The hook lands at `<git root>/.githooks/pre-commit` — the source's own repo,
or the enclosing host repo when the source is registered as a subdirectory of
one (see the topology cases below). If `core.hooksPath` is unset, the install
also runs `git config core.hooksPath .githooks` so the hook is picked up
without manual git config. Pointing `core.hooksPath` at `.githooks` makes git
run every executable script in that directory and ignore `.git/hooks/*` for
every hook type, so the installer writes the gbrain hook but leaves
`core.hooksPath` unset (`hook written …; core.hooksPath left unset`) and
prints the reason plus the manual wiring step when:

- `core.hooksPath` is already set — in any scope, a global one from husky,
  secret-scanner templates or dotfiles counts — to somewhere other than
  `.githooks` (git reads hooks only from there, so the gbrain hook would be
  inert) — copy `.githooks/pre-commit` into that directory, or point
  `core.hooksPath` at `.githooks`; a value that already resolves to
  `.githooks` is left alone and counts as wired;
- `.githooks/` already holds other executable hook scripts (third-party
  clones commit `post-commit`, `pre-push`, … there as a convention) — review
  them, then `git -C <root> config core.hooksPath .githooks`;
- `.git/hooks/` holds an active hook (executable, not `*.sample` — a host
  repo's own pre-push, commit-msg, framework-installed hooks, …) — move them
  into `.githooks/`, then run the same command.

A source is skipped only when it sits outside any git repo (`skipped, Not
inside a git repository: …`), its path contains a line terminator, which
the generated shell script could not carry safely (`skipped, source path
contains a line terminator; refusing to install hook`), or `.githooks/` /
`.githooks/pre-commit` is a symlink (`Refusing to write through a symlink: …`
— the installer never writes or removes through the link; the other sources
still install).

## Bypass

Standard git escape hatch:

```bash
git commit --no-verify
```

This skips ALL pre-commit hooks. Use sparingly — the next time the user
runs `gbrain doctor`, the issues will surface.

## Uninstall

```bash
gbrain frontmatter install-hook --uninstall
```

If a `.bak` was saved during install, it's restored as the active hook.
Otherwise the hook is removed cleanly.

## Behavior on machines without gbrain installed

The hook script checks for `gbrain` on `$PATH`. When missing, it prints a
one-line warning to stderr and exits 0 — commits aren't blocked just because
a developer hasn't installed gbrain locally. Once gbrain is installed, the
hook resumes blocking malformed pages.

## For downstream agent forks

If your OpenClaw wraps gbrain in a host repo
that's not the brain repo itself, you may want a separate hook strategy:

- **Brain repo IS the host repo** (gbrain skills + brain pages in one repo):
  install via `gbrain frontmatter install-hook` as above.
- **Brain repo is a separate registered source** (e.g. `~/brain` registered
  as a source, host repo is `~/agent-fork`): install in the brain repo only;
  agent-fork code doesn't need this hook.
- **Brain is a subdirectory of the host repo** (the `<workspace>/brain` layout
  `gbrain bootstrap` creates and registers with
  `gbrain sources add <id> --path <workspace>/brain`): the hook installs at the
  host repo root, scoped to `brain/` — staged files elsewhere in the host repo
  (README, AGENTS.md, code) are never validated. Several nested sources in one
  host repo share a single hook (their scopes union; `--uninstall --source
  <id>` drops only that source's scope); a source registered at the root
  widens it to the whole repo. Known limitation: a nested page that declares
  `slug:` explicitly can be reported as `SLUG_MISMATCH`, because
  `frontmatter validate` derives the expected slug from the git root; pages
  gbrain writes itself carry no `slug:`, so bootstrap-created brains are
  unaffected.
- **Brain repo is auto-generated** (e.g. by a sync daemon writing to a
  bucket): skip the hook entirely; gate at the writer instead via
  `import { writeBrainPage } from 'gbrain/brain-writer'` (planned in a
  later release; currently the CLI is the surface).

## How it fits into the broader frontmatter pipeline

```
agent writes a page         git commit                 doctor scan
       ↓                          ↓                          ↓
[source content]   →  [pre-commit hook validates]   →  [frontmatter_integrity check]
       ↓                          ↓                          ↓
  raw file on disk       blocks malformed commits     surfaces existing issues
                                                             ↓
                                                  `gbrain frontmatter validate
                                                   <source-path> --fix`
                                                   (writes .bak backups)
```

The hook is the write-time gate; doctor is the audit gate; the CLI is the
fix tool. They share `parseMarkdown(..., {validate:true})` as the single
source of truth for what counts as malformed.
