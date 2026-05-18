# Pre-commit hook for brain repos (v0.22.4+)

`gbrain frontmatter install-hook` installs a git pre-commit hook in your
brain source's repo that runs `gbrain frontmatter validate` against staged
`.md` and `.mdx` files. Malformed frontmatter blocks the commit. Bypass with
`git commit --no-verify`.

## What the hook catches

The same seven validation classes the `frontmatter-guard` skill and
`gbrain doctor`'s `frontmatter_integrity` subcheck report:

| Code              | What it catches                                                     |
|-------------------|---------------------------------------------------------------------|
| `MISSING_OPEN`    | File doesn't start with `---`                                       |
| `MISSING_CLOSE`   | No closing `---` before first heading                               |
| `YAML_PARSE`      | YAML failed to parse (syntax or structure)                          |
| `SLUG_MISMATCH`   | `slug:` in frontmatter doesn't match path-derived slug              |
| `NULL_BYTES`      | Binary corruption (`\x00`) anywhere in the content                  |
| `NESTED_QUOTES`   | `title: "outer "inner" outer"` shape that breaks YAML               |
| `EMPTY_FRONTMATTER` | `---` ... `---` with nothing meaningful between                   |

## Install

For all registered sources that are git repos:

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

The hook lands at `<source>/.githooks/pre-commit`. If `core.hooksPath` is
unset, the install also runs `git config core.hooksPath .githooks` so the
hook is picked up without manual git config.

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
