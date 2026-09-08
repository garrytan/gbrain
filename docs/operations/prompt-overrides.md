# Prompt overrides

Every system prompt gbrain sends is catalogued, and the ones that are plain text
can be replaced from the CLI without forking the repo. Overrides live in brain
config under `prompts.<id>` and apply on the next LLM call — no restart, no
rebuild.

**Say to your agent:** *"show me the prompts gbrain uses"* — *"override the fact
extractor prompt"* — your agent runs `gbrain prompts list` / `gbrain prompts set`.

The orienting idea: a company brain and a personal brain want different
instructions from the same code. Extraction that should skip work-session
narration in one brain is exactly what another brain wants captured. Editing the
constant means carrying a fork forever; a config row means the operator owns the
text and still takes every upgrade.

## The commands

```bash
gbrain prompts list                          # every prompt, grouped, with override state
gbrain prompts list --group dream-cycle      # one group
gbrain prompts list --overridden             # only what you have changed
gbrain prompts show cycle.propose_takes      # the effective text
gbrain prompts show cycle.propose_takes --default   # the built-in text

gbrain prompts set facts.extractor --file my-extractor.txt
cat my-extractor.txt | gbrain prompts set facts.extractor --stdin

gbrain prompts reset facts.extractor         # back to the built-in text
```

`set` reads from a file or stdin rather than an argument, because prompts are
multi-line and a shell argument mangles them. Add `--json` to any subcommand for
scripting.

Overrides are a trusted-local, operator-plane action, like `gbrain config set`.
They are deliberately NOT exposed as an MCP operation: an override rewrites the
instructions every later LLM call runs under, so an agent must not be able to
set one on itself.

## Two tiers, and why

`gbrain prompts list` marks each entry `default`, `OVERRIDDEN`, or `read-only`.

- **Editable** — the call site resolves through `resolvePromptText(engine, id,
  DEFAULT)`, so a config row wins. This is most of the catalog: fact extraction,
  the dream-cycle phases, think's base prompt, the conversation parsers,
  chronicle segmentation, takes bootstrap, thin-page enrichment.
- **Read-only** — the prompt is a template function that interpolates runtime
  values, or it runs on a path with no engine handle (a hot search tie-break, a
  pure classifier). These are listed for traceability: `gbrain prompts show <id>`
  prints the text and `defined_at` names the constant, so you can read what the
  system is asking before deciding you need a code change. `set` refuses them.

Converting a read-only entry to editable is a small, mechanical change: extract
the prompt skeleton into `{PLACEHOLDER}` form, thread `resolvePromptText` at its
call site, flip `editable` in the registry.

## Placeholders are enforced

Some prompts carry `{TOKEN}` slots the call site substitutes at runtime —
`{PAGE_BODY}`, `{EVIDENCE_BLOCK}`, `{SCORECARD_JSON}`, `{SKIP_SENTINEL}`. An
override that drops one is refused with the missing tokens named, because the
call site would otherwise send a prompt with no evidence in it and the phase
would fail in a way that looks like a model problem.

```
$ gbrain prompts set cycle.grade_takes --file bad.txt
prompts: missing_placeholders: {CLAIM}, {EVIDENCE_BLOCK} — the call site
substitutes these at runtime; the override must keep them
```

Saving the built-in text verbatim clears the override instead of storing it. A
config row holding today's default would shadow an improved default shipped by a
later upgrade.

## Version-cached phases invalidate correctly

`propose_takes`, `grade_takes` and `calibration_profile` cache their work keyed
on a prompt version, so a page or take already judged is not re-judged. If an
override changed the instructions but not the version, those caches would serve
verdicts produced by a prompt that no longer exists.

While an override is active the effective version gains a short content digest:

```
v0.36.1.0-stub          # built-in
v0.36.1.0-stub+2f1a9c4e # overridden
```

That is enough to make the per-page skip-seen check and `take_grade_cache` miss,
so the affected work re-runs once under the new instructions. `gbrain prompts
set` prints the new version when it changes. Resetting restores the base version,
and any verdicts cached under it are reusable again.

## Relationship to `facts.extraction_prompt_appendix`

The older `facts.extraction_prompt_appendix` config key appends operator text
after the fact-extractor prompt. It still works, and it composes with an
override: the override replaces the built-in extractor text, then the appendix is
appended to whatever base is in effect. Use the appendix to add a rule, an
override to rewrite the instructions.

## Guardrails

- Overrides cap at 32,000 characters.
- An empty or whitespace-only value is treated as unset, so a botched save can't
  blank a system prompt.
- A config-read failure falls back to the built-in text. A prompt lookup never
  takes down an LLM phase.
- Nothing is cached process-wide: the resolve happens per run.

## Adding a prompt to the catalog

New LLM prompts belong in `src/core/prompts/registry.ts` with an id, a group, a
one-line description, `definedAt`, the default text, and any required
placeholders. Feature modules import `./prompts/resolve.ts` only, never the
registry — the registry imports the feature modules' prompt constants, so an
import in the other direction would be a cycle.
