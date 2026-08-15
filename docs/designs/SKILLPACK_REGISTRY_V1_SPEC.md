# Skillpack Publish + Registry + Install Spec (post-v0.36.0.0)

> **⚠️ Needs v0.36 realignment.** This spec was written assuming the pre-v0.36
> managed-block install model (which v0.36.0.0 retired in favor of
> scaffold + reference + harvest). The strategic decisions remain sound — third-party
> publish + registry + doctor + rubric + tarball + TOFU + sandbox + CI workflow
> split + anti-typosquat — but the **verbs and integration points change**:
>
> | Old spec verb | v0.36-aligned verb | What changes |
> |---|---|---|
> | `gbrain skillpack install <name>` | `gbrain skillpack scaffold <source>` | One-time additive copy, no managed block, refuses to overwrite. |
> | `gbrain skillpack uninstall <name>` | (gone) | User owns files; deletes via `rm` or git. |
> | Auto-walk runbook | Display `bootstrap.md` post-scaffold | Already aligned with codex T1 (per-step approval) — becomes a printed checklist, not an executor. |
> | Multi-source resolver receipt | Per-scaffold state in `~/.gbrain/skillpack-state.json` | Codex G1 was the right call; v0.36 retired the resolver-block anyway. |
> | Auto-rename collision | Refuses-to-overwrite (v0.36's contract) | Codex was right; v0.36 already enforces it. |
> | Update path | `gbrain skillpack reference <name> [--apply-clean-hunks]` | Diff-lens with optional auto-merge of clean hunks. |
>
> What stays verbatim: registry at `garrytan/gbrain-skillpack-registry`, rubric,
> doctor, anatomy doc, tarball determinism, TOFU + SHA pinning, endorsement
> tiers, sandbox + env scrub, CI workflow split, anti-typosquat. See
> `docs/guides/skillpacks-as-scaffolding.md` (the v0.36 canonical model) for
> the contract this spec must align to before implementation.
>
> See [README at top of file for status; full spec preserved below as the strategic record.]

## Context

After v0.36.0.0 (Hindsight Calibration), gbrain has a mature skillpack system —
but it only knows how to install the **one** bundle declared in
`openclaw.plugin.json` at gbrain's own repo root. Garry wants to ship a
"hackathon-evaluation" skillpack as a standalone artifact, any gbrain user
should be able to discover + install it, and the ecosystem should grow
without Garry hand-curating every README. That requires five new capabilities:

1. **Publish** — a documented repo layout + manifest format that anyone can
   point a git repo at and call "a skillpack."
2. **Distribute** — a transport from one user's machine to another. Git +
   tarball, no centralized hosting infra.
3. **Install** — extend `gbrain skillpack install` to accept a third-party
   source, with trust posture appropriate for installing markdown/SKILL.md
   files into a workspace that an agent then routes through.
4. **Discover + curate** — a canonical catalog at
   `github.com/garrytan/gbrain-skillpack-registry` (the Printing Press
   library pattern) with endorsement tiers, security gating, and
   programmatic search. Third-party packs live in their authors' repos;
   the registry is a `registry.json` manifest pointing at them.
5. **Cross-distribute** — list in `mvanhorn/printing-press-library` as a
   sister registry, AND use Printing Press to generate an agent-native CLI
   wrapper around gbrain's HTTP MCP so non-gbrain agents can hit a gbrain
   instance remotely. Doubles the discovery surface.

The intended outcome is: `gbrain skillpack install hackathon-evaluation`
resolves through the registry, clones the source repo (or fetches the
pinned tarball), validates the manifest, drops the skill files into the
workspace, and routes them via RESOLVER.md / AGENTS.md — same code paths as
the bundled install today, just with a remote source and a registry catalog
in front.

## Landscape (informs every design choice below)

- `agentskills.io` is the open SKILL.md standard adopted across Claude
  Code / Codex / Cursor / Gemini CLI / OpenClaw. The format is solved.
- ~2,500 Claude Code marketplaces already exist (claudemarketplaces.com).
  Hosting is solved 2,500 times over. The moat is curation + quality bar.
- **13% of skills in existing marketplaces carry critical vulnerabilities**
  (per tech-leads-club, May 2026). Security gating at publish time is a
  real differentiator, not a vanity feature.
- `mvanhorn/cli-printing-press` (~1.4k stars) splits the engine from the
  library exactly the way this plan proposes. The publish-skill pattern
  (`/printing-press-publish`) is the load-bearing UX move — no contributor
  hand-runs git. We replicate it.
- gbrain skillpacks have a **runtime contract** (they assume `gbrain query`,
  `put_page`, sources, takes, hindsight calibration). They are not portable
  to a generic agent harness without gbrain installed. That's what justifies
  a dedicated registry instead of mirroring agentskills.io — the validation
  surface is gbrain-shaped.

## Today's baseline (what exists, won't be re-built)

- `BundleManifest` schema in `src/core/skillpack/bundle.ts:13-20`
  (`name`, `version`, `description`, `skills[]`, `shared_deps[]`,
  `excluded_from_install?[]`). Reuse + extend; do not re-invent.
- `installer.ts:259-293` — cumulative-slugs receipt embedded in the managed
  block (`<!-- gbrain:skillpack:manifest cumulative-slugs="..." version="..." -->`).
  Single source of truth for "what's installed from gbrain."
- `installer.ts:376-402` — per-file byte-compare gate before install /
  uninstall (D11). Refuses to clobber user edits without `--overwrite-local`.
- `installer.ts:180-253` — atomic lockfile with 10-min stale threshold and
  PID liveness check. Concurrency safety.
- `src/core/git-remote.ts` — SSRF-hardened `cloneRepo` / `pullRepo` with
  `https://`-only scheme allowlist, no submodules, no redirects, no
  `protocol.file`/`protocol.ext`. Same primitive remote-sources uses.
- `src/core/url-safety.ts:isInternalUrl` — blocks RFC1918 / CGNAT /
  metadata-IP / IPv6-loopback. Already wired through `parseRemoteUrl`.
- `src/core/resolver-filenames.ts` — RESOLVER.md / AGENTS.md filename
  fallback chain. Per-skill rows live in a managed block inside one of
  these files.

## Recommended design

### Distribution: git + tarball, v1

A skillpack is **a git repo with `skillpack.json` at root + a `skills/`
directory**. A `.tgz` of that same tree is an offline-transportable form
of the same thing. Both paths land in the same installer.

- `gbrain skillpack install <owner>/<repo>` — clones via existing
  `git-remote.ts` SSRF-hardened path.
- `gbrain skillpack install <url.git>` — verbatim https URL.
- `gbrain skillpack install <path/to/pack.tgz>` — extract to cache dir,
  install from extracted tree. Useful inside YC orgs / corp networks that
  block direct GitHub access, or for air-gapped distribution.
- `gbrain skillpack install <path/to/repo>` — local path (skill authors
  testing).
- `gbrain skillpack pack [--out <path>]` — publisher-side command that
  validates the manifest, runs the full `pack --dry-run` pipeline, and
  emits `<name>-<version>.tgz`. SHA-256 of the tarball is recorded in the
  TOFU receipt so re-install of the same tarball is silent, but a
  tampered tarball with the same filename fails loud.
- Tarball schema: gzipped tar with `skillpack.json` at the top level and
  `skills/...` beneath it. No symlinks, no executables, no dotfiles
  outside an allowlist (`.gitignore`, `.gitattributes`). Validator runs
  on extract.

Tarballs are an additive transport, not a different artifact shape. The
installer normalizes both paths to "extracted tree on disk" before the
existing `enumerateBundle` + `applyInstall` pipeline runs.

### Registry: github.com/garrytan/gbrain-skillpack-registry

A separate git repo Garry controls. **Not** a hosting layer — a catalog.
Skillpacks live in their authors' own repos; the registry points at them.

Two files at the registry repo root:

- `registry.json` — the live catalog. Schema:

  ```json
  {
    "schema_version": "gbrain-registry-v1",
    "updated_at": "2026-06-12T15:00:00Z",
    "skillpacks": [
      {
        "name": "hackathon-evaluation",
        "description": "Score hackathon submissions with the YC rubric.",
        "author": "Garry Tan",
        "author_handle": "garrytan",
        "homepage": "https://github.com/garrytan/skillpack-hackathon-evaluation",
        "source": {
          "kind": "git",
          "url": "https://github.com/garrytan/skillpack-hackathon-evaluation.git",
          "pinned_commit": "abc1234567890..."
        },
        "tarball_sha256": "deadbeef...",
        "gbrain_min_version": "0.36.0",
        "tier": "endorsed",
        "tags": ["evaluation", "yc", "founders"],
        "validated_at": "2026-06-12T15:00:00Z",
        "validation_run_id": "2026-06-12T14-58-...",
        "skills_count": 2,
        "skills": ["judge-submission", "score-rubric"]
      }
    ]
  }
  ```

- `endorsements.json` — Garry-controlled. The single source of truth for
  which entries get the `endorsed` tier. Decoupling the endorsement
  decision from the catalog write means a contributor's PR can land a
  catalog entry at the `community` tier; promotion to `endorsed` is a
  separate, smaller, Garry-only commit.

**Endorsement tiers:**

- `endorsed` — Garry has used it, it works, it's in his pinned set.
  Listed first in `gbrain skillpack search` output. Manual promotion.
- `community` — passed the publish-gate validation, lives in the catalog,
  but Garry hasn't personally vetted it. Default tier on first PR.
- `experimental` — author self-flagged as in-development. Listed last,
  with a stderr warning at install time.

**CLI integration:**

```
gbrain skillpack search <query> [--tier endorsed|community|experimental] [--json]
gbrain skillpack info <name>             # from registry, not from local install
gbrain skillpack install <name>          # resolves through registry by short name
gbrain skillpack install <url|tarball>   # still works for direct installs
gbrain skillpack install starter-pack    # special bundle entry in registry.json
gbrain skillpack registry [--url <url>]  # show/set the configured registry
```

`--url` defaults to `https://raw.githubusercontent.com/garrytan/gbrain-skillpack-registry/main/registry.json`.
Operators inside corp networks can point at a fork. The registry URL is
recorded in `~/.gbrain/config.json` under `skillpack.registry_url`.

`gbrain skillpack install starter-pack` resolves a special `bundles` array
in `registry.json` (a named list of skillpack names) and installs each in
order. Garry curates the starter pack.

**First-install identity confirm + anti-typosquat (codex G4):**

`gbrain skillpack install <name>` on first install of a given source
surfaces a confirm prompt with full identity:

```
[skillpack] About to install:
  Name:          hackathon-evaluation
  Author:        garrytan
  Source:        https://github.com/garrytan/skillpack-hackathon-evaluation
  Pinned commit: abc1234567890abcdef1234567890abcdef12345
  Tier:          endorsed
  Tarball SHA:   sha256:deadbeef...
Continue? [y/N]
```

Honored on TTY; non-TTY requires `--trust` flag and prints the same
block to stderr.

Subsequent installs of the same `<author>/<name>` pair at the same
pinned commit + tarball SHA skip the prompt (already trusted).
Different pinned commit re-prompts. Different author with the same
name re-prompts (someone may have transferred / forked the pack).

**Registry-side anti-typosquat gate:** the publish-gate (post-merge
workflow) rejects new submissions whose name is within Damerau-
Levenshtein edit-distance 2 of any existing `endorsed`-tier pack
name. Community-tier packs do NOT block (the registry shouldn't be
the typosquat arbiter for low-tier packs; the install-time confirm
is the user-facing defense). Effort: ~0.5d to wire the distance check
into the validate-pr.yml manifest scan; uses an off-the-shelf
distance algorithm (no external dep).

**Bundle atomicity contract** (per eng-review D3): per-pack independent.
Each pack in a bundle install is its own transaction in the managed
block. Mid-bundle failure leaves earlier successful packs installed,
skips later packs, and prints a summary:

```
[skillpack] starter-pack: 3 of 5 installed
  ✓ hackathon-evaluation @ 0.1.0
  ✓ founder-scorecard    @ 0.2.0
  ✗ resume-roaster       — pinned commit unreachable
  ⤓ market-sizer         — skipped after failure
  ⤓ pitch-doctor         — skipped after failure
Retry the failed pack with: gbrain skillpack install resume-roaster
```

Matches the multi-source resolver design (each source independent).
Partial progress is recoverable; no surprise rollback. Failures inside
a bundle do not poison the user's RESOLVER.md / AGENTS.md.

**Endorsement workflow**: a dedicated CLI command edits
`endorsements.json` with schema validation. Hand-editing remains
possible (it's just JSON), but the command is the canonical path.

```
gbrain skillpack endorse <name> [--tier endorsed|community|experimental]
                                [--push] [--dry-run]
```

Run from a clone of `garrytan/gbrain-skillpack-registry`. Steps:
1. Read + validate current `endorsements.json` against the schema.
2. Confirm `<name>` exists in `registry.json`.
3. Update or insert the entry with the new tier.
4. Write back with stable key ordering (so diffs are clean).
5. Stage + create a one-line conventional commit: `endorse: <name> -> <tier>`.
6. If `--push`, push to `main`. Otherwise print "now run git push" hint.

### Publish-gate skill: /gbrain-skillpack-publish

Mirrors `mvanhorn/cli-printing-press`'s `/printing-press-publish` exactly.
No contributor hand-runs git. The skill drives:

1. **Local validation** (`gbrain skillpack pack --dry-run`):
   - `skillpack.json` schema check
   - SKILL.md frontmatter on every listed skill
   - File-type allow-list (no `.env`, `.ssh`, `.pem`, no executables)
   - Slug-collision sweep against the live `registry.json`
   - `gbrain check-resolvable` clean
   - `gbrain routing-eval` clean (structural layer)
2. **Security gates** (publish-gate v1, see decision Q3):
   - Static analysis on any embedded scripts (shellcheck for `.sh`,
     a heuristic JSON/YAML safety pass on data files)
   - Dependency declaration check — every external resource referenced
     in SKILL.md must be in a declared `external_resources:` array
   - Trial install: extract pack into a tempdir, run `gbrain skillpack
     install <tempdir>` against an ephemeral PGLite-backed gbrain (mirrors
     the `test/e2e/longmemeval` ephemeral-PGLite pattern at
     `src/eval/longmemeval/harness.ts`), assert `gbrain check-resolvable`
     stays clean and the skill rows appear in the managed block.
   - Trial install runs with `GBRAIN_SKILLPACK_SANDBOX=1`, which disables
     any operation that writes outside the workspace or hits the network.

3. **Test + eval suite execution** (DX-review decision: run everything
   in the sandbox so endorsement signals are measurable):
   - **Unit tests**: walk every `unit_tests[]` glob inside the sandbox,
     run via `bun test`, collect pass/fail per file.
   - **E2E tests**: if a `DATABASE_URL` is exposed inside the sandbox
     (Linux: `unshare`'d PG socket; macOS: docker-bridged); skip-gracefully
     when not.
   - **LLM-judge evals**: load each `*.judge.json`, run the cross-modal
     pipeline with `__setChatTransportForTests` stubbed gateway so the
     publisher pays zero LLM cost during the publish gate. The publisher
     ran real-gateway evals before submitting; the validation log links
     to their results. Sandbox re-runs against the stubbed gateway prove
     the pipeline runs end-to-end and the eval JSON is well-formed.
   - **Routing evals**: structural matching via the existing
     `gbrain routing-eval` command. Asserts every `intent` in
     `routing-eval.jsonl` resolves to the declared `expected_skill`
     given the skill's `triggers:` frontmatter.
   - **Coverage score**: published as a single percentage in the
     validation log. Drives tier eligibility:
     - `endorsed`: routing + runbooks + >=95% pass.
     - `community`: routing + install runbook + >=80% pass.
     - `experimental`: anything that passes structural validation.
   - **Failed eval / test surfaces actionable line**: each failure
     in the validation log includes the file path, the assertion, and
     a paste-ready re-run command (`bun test <file>` or
     `gbrain routing-eval skills/<name>/routing-eval.jsonl`).
3. **Tarball + hash**:
   - `gbrain skillpack pack --out skillpack-<name>-<version>.tgz`
   - SHA-256 recorded for registry pin
4. **Registry PR** (Printing Press pattern verbatim):
   - Fork `garrytan/gbrain-skillpack-registry` if not already forked
   - Branch `add-<name>-<version>`
   - Append catalog entry to `registry.json` with tier=`community`,
     pinned commit, tarball SHA-256, validated_at timestamp, and a
     `validation_run_id` that points at a JSON log committed to a
     `validation-runs/<run-id>.json` file under the registry repo so
     anyone can audit what was checked
   - Open PR against `garrytan/gbrain-skillpack-registry:main` with the
     validation log in the body
   - Stretch: Garry's `endorse <name>` command flips the entry to
     `endorsed` via a one-line commit on `endorsements.json`

The skill file itself ships in the gbrain skillpack at
`skills/gbrain-skillpack-publish/SKILL.md`. Invokable from any agent
harness that loads gbrain skills.

### Printing Press cross-distribution

Two-direction integration (decision Q2):

- **Cross-list**: open a PR against `mvanhorn/printing-press-library`
  registering `garrytan/gbrain-skillpack-registry` as a sister-registry
  in their catalog (their library has a `sister_registries:` section per
  their AGENTS.md). Their 1.4k-star audience discovers gbrain through
  the same search surface they already use.
- **Generate**: run `printing-press print` against `gbrain serve --http`'s
  OpenAPI spec (gbrain's HTTP MCP exposes a JSON-RPC surface with stable
  tool definitions). The output is a `gbrain-cli` agent-native binary
  with SQLite mirror that any agent — not just gbrain users — can use to
  hit a remote gbrain. Submitted back to `mvanhorn/printing-press-library`
  as a published CLI, credited to Garry. Doubles distribution surface and
  turns gbrain into something Printing Press users can route through.

The cross-list is ~1 day. The generated CLI is ~1 week and produces a
genuinely new artifact that didn't exist before: gbrain-as-a-service
viewed from outside the gbrain runtime.

### Manifest schema: `skillpack.json` (cathedral artifact)

A gbrain skillpack is a **full software package**, not just markdown.
Same shape as npm/cargo: code, tests, evals, runbooks, changelog. This
is the differentiation moat per the DX review: nobody else ships AI
evals and agent-readable install/upgrade runbooks as first-class
package artifacts.

```json
{
  "api_version": "gbrain-skillpack-v1",
  "name": "hackathon-evaluation",
  "version": "0.1.0",
  "description": "Score hackathon submissions with the YC rubric.",
  "author": "Garry Tan <garry@ycombinator.com>",
  "license": "MIT",
  "homepage": "https://github.com/garrytan/skillpack-hackathon-evaluation",
  "gbrain_min_version": "0.36.0",
  "skills": ["skills/judge-submission", "skills/score-rubric"],
  "shared_deps": [],
  "excluded_from_install": [],

  "unit_tests": ["test/**/*.test.ts"],
  "e2e_tests": ["e2e/**/*.test.ts"],
  "llm_evals": ["evals/*.judge.json"],
  "routing_evals": ["skills/*/routing-eval.jsonl"],
  "runbooks": {
    "install": "runbooks/install.md",
    "uninstall": "runbooks/uninstall.md",
    "upgrades": "runbooks/upgrade-*.md"
  },
  "changelog": "CHANGELOG.md"
}
```

**Field semantics:**

- `api_version` — forward-compat key; installer refuses unknown.
  Schema is `gbrain-skillpack-v1`. Codex outside-voice gap: single
  `api_version` doesn't cover runbook/eval/sandbox schema evolution.
  Manifest also carries `runbook_schema_version` (default 1) +
  `eval_schema_version` (default 1). Installer accepts a configured
  range per dimension; rejects manifests declaring a newer schema
  than the local gbrain supports with a paste-ready `gbrain upgrade`
  hint. Refuses silent downgrade.
- `gbrain_min_version` — fail-fast version gate (existing semver helper).
- `name` — must match the directory name; unique in registry namespace.
- `skills[]` — relative paths from repo root; same as today's `enumerateBundle`.
- `unit_tests[]` — glob(s) discovered in the sandbox and run during the
  publish gate. Pure Bun unit tests, no DB.
- `e2e_tests[]` — glob(s) for integration tests. Run if `DATABASE_URL`
  is reachable inside the sandbox (skip-gracefully otherwise).
- `llm_evals[]` — cross-modal eval configs in the gbrain v0.27.x format
  (task/output prompt with multi-model judging). Run with a **stubbed
  gateway** in the publish-gate sandbox so no real API spend; the
  publisher's machine runs real-gateway evals before submitting.
- `routing_evals[]` — `routing-eval.jsonl` files with `{intent,
  expected_skill, ambiguous_with?}` rows. Structural matching against
  the skill's `triggers:` frontmatter. The single highest-leverage eval
  type for an agent-routed skillpack: proves user phrases actually fire
  the right skill.
- `runbooks.{install, uninstall}` — agent-readable markdown (see
  format below).
- `runbooks.upgrades` — glob expanding to `upgrade-<from>-to-<to>.md`
  files; the agent picks the right one based on the version recorded
  in the resolver receipt.
- `changelog` — required; the agent surfaces "what changed" at upgrade
  time directly from this file.

**Tier eligibility based on coverage** (publish-gate scores each pack):

- `endorsed` tier requires: routing-evals AND runbooks AND >=95% pass on
  declared tests + evals.
- `community` tier requires: routing-evals AND install.md AND >=80%
  pass on declared tests + evals.
- `experimental` tier accepts anything that passes structural validation.

A pack with 0 evals + 0 tests is publishable as `experimental` only.
The publish-gate emits a one-line score summary so the publisher sees
exactly what's blocking promotion.

### Install/upgrade trust model: per-step approval, not auto-walk (codex T1)

The DX review's first cut had `gbrain skillpack install <name>` auto-
walk `runbooks/install.md` after dropping files. Codex pointed out
that this runs trusted-path (`remote=false`) gbrain CLI calls against
the user's brain on every install — a malicious community-tier pack
mutates brain state on first install. v1 fix: **runbook executor
defaults to per-step approval**.

- `gbrain skillpack install <name>` ALWAYS drops files + updates the
  resolver block. That part is content-only; the trust gates (TOFU
  + content-hash + endorsement tier) already cover it.
- After file-drop, if `runbooks/install.md` exists, the install
  command **prints each step + waits for explicit y/N** on a TTY.
  Three step kinds (`agent:`, `show user:`, `ask user:`) all surface
  the literal text before execution.
- `--runbook-apply-all` flag bypasses the per-step prompt for CI /
  unattended agent use. Loud stderr line on first use:
  `[skillpack] applying runbook unattended; this skillpack is community
  tier — confirm trust by inspecting <pack-dir>/runbooks/install.md`.
- `--runbook-skip` lands the files without executing any runbook step
  (the publisher gets file-drop only; everything else is the user's
  decision).
- `endorsed` tier eligible for an auto-walk-after-N-installs UX in
  v1.1 (after the user has confirmed N runbook walks of that pack
  succeed, prompt drops). Out of scope for v1.

This is the npm postinstall lesson learned the hard way:
auto-execute on install is how supply-chain attacks happen.
Per-step + dry-run + endorsement is how trust gets earned.

### Agent runbook format (runbooks/install.md, uninstall.md, upgrade-*.md)

Mirrors gbrain's own `skills/migrations/v0.21.0.md` pattern — markdown
that an agent reads top-to-bottom and executes step-by-step.

```markdown
---
runbook_kind: install
gbrain_version_range: ">=0.36.0 <0.37.0"
skillpack: hackathon-evaluation
skillpack_version: 0.1.0
---

# Install runbook: hackathon-evaluation v0.1.0

1. **agent:** `gbrain put_page wiki/_skillpack-hackathon-evaluation
   --frontmatter type=skillpack-config`
   - Why: bootstraps the config page this skillpack reads from.
2. **show user:** "Hackathon evaluation is installed. Try: 'Judge this
   submission against the YC rubric.'"
3. **ask user:** "Want a starter list of evaluation criteria added to
   your brain?"
   - On yes: `gbrain put_page wiki/concepts/yc-rubric < seeds/rubric.md`
   - On no: skip.
```

Three step kinds, each a tagged-line shape so the runbook parser is
unambiguous:

- **`agent:`** — the calling agent runs the command verbatim.
- **`show user:`** — display the message to the user (no action).
- **`ask user:`** — require user confirmation; the next step is gated.

Upgrade runbooks (`upgrade-<from>-to-<to>.md`) follow the same shape
with extra frontmatter (`from_version`, `to_version`) so the
upgrade-walker picks the right runbook when stepping multi-version
upgrades (e.g., v0.1 → v0.2 → v0.3 walks two runbooks in sequence).

### Quality rubric + doctor + reference pack

A skillpack is only as good as the agent's ability to tell whether it's
ready. Three artifacts close the loop:

**1. Declarative rubric — `src/core/skillpack/rubric.ts`**

Single source of truth. The doctor walks it; the anatomy doc is
auto-generated from it; tests pin every dimension. When the rubric
evolves (v1.1 adds dimensions, v2 changes scoring), one file moves
and docs stay in sync. Same pattern as gstack's
`scripts/question-registry.ts`.

```ts
export const SKILLPACK_RUBRIC_V1: RubricDimension[] = [
  {
    id: 1,
    name: 'manifest_valid',
    description: 'skillpack.json passes the v1 schema',
    check: async (pack) => validateManifest(pack),
    fix_hint: 'Run: gbrain skillpack init <name> to regenerate a valid stub',
    weight: 1,
  },
  {
    id: 2,
    name: 'skills_have_skill_md',
    description: 'Every listed skill has SKILL.md with valid frontmatter (name, description, triggers, mutating, writes_pages)',
    check: async (pack) => allSkillsHaveValidSkillMd(pack),
    fix_hint: 'Run: gbrain skillify scaffold <skill-name>',
    weight: 1,
  },
  {
    id: 3,
    name: 'routing_evals_present',
    description: 'Every skill has routing-eval.jsonl with >= 5 intents',
    check: async (pack) => allSkillsHaveRoutingEvals(pack, 5),
    fix_hint: 'gbrain skillify scaffold drops 5 example intents per skill',
    weight: 1,
  },
  {
    id: 4,
    name: 'routing_evals_clean',
    description: 'gbrain routing-eval passes structurally for every routing-eval.jsonl',
    check: async (pack) => runRoutingEvalStructural(pack),
    fix_hint: 'Add the missing trigger phrase to the skill\'s `triggers:` frontmatter, or move the intent to the correct skill',
    weight: 1,
  },
  {
    id: 5,
    name: 'check_resolvable_clean',
    description: 'gbrain check-resolvable passes for this pack\'s resolver entries (MECE, no DRY violations, all triggers reach skills). Runs against a PACK-LOCAL fixture, not the ambient workspace.',
    check: async (pack) => runCheckResolvableIsolated(pack),
    fix_hint: 'Add a resolver row for the missing skill, or remove the orphan trigger',
    weight: 1,
  },
  // Note (codex outside-voice gap): the existing `check-resolvable`
  // implementation (src/core/check-resolvable.ts) merges resolver files
  // from skillsDir AND its parent — workspace-global. A pack-local
  // publish gate must pass / fail purely on the pack's own resolver
  // entries, not on whatever's installed in the publisher's local
  // workspace. The doctor and publish-gate wrap check-resolvable in an
  // isolated tempdir fixture that contains ONLY this pack's
  // RESOLVER.md and its declared skills/, so the result is pack-local.
  // Exposed as `runCheckResolvableIsolated(pack)` in
  // `src/core/skillpack/check-resolvable-isolated.ts`.
  {
    id: 6,
    name: 'unit_tests_present',
    description: 'Every skill has at least one unit test that imports it (test/**/*.test.ts)',
    check: async (pack) => everySkillHasUnitTest(pack),
    fix_hint: 'gbrain skillify scaffold drops a passing example.test.ts you can extend',
    weight: 1,
  },
  {
    id: 7,
    name: 'llm_eval_present',
    description: 'At least one LLM-judge eval at evals/*.judge.json with >= 3 cases',
    check: async (pack) => hasLlmJudgeEval(pack, 3),
    fix_hint: 'gbrain skillify scaffold-eval <skill-name>',
    weight: 1,
  },
  {
    id: 8,
    name: 'install_runbook_present',
    description: 'runbooks/install.md exists, parses, and has at least one step',
    check: async (pack) => parseRunbook(pack, 'install'),
    fix_hint: 'gbrain skillpack init regenerates the stub; edit to taste',
    weight: 1,
  },
  {
    id: 9,
    name: 'uninstall_runbook_present',
    description: 'runbooks/uninstall.md exists, parses, and has at least one step',
    check: async (pack) => parseRunbook(pack, 'uninstall'),
    fix_hint: 'gbrain skillpack init regenerates the stub',
    weight: 1,
  },
  {
    id: 10,
    name: 'changelog_present_and_current',
    description: 'CHANGELOG.md present, contains a `## [<current-version>]` entry, follows Keep-a-Changelog shape',
    check: async (pack) => changelogReferencesVersion(pack),
    fix_hint: 'Add a `## [<version>] - <YYYY-MM-DD>` entry. Use gbrain skillpack doctor --fix to auto-generate from VERSION + git log.',
    weight: 1,
  },
];
```

**Score bands:**

- `10/10` → **endorsed-eligible** (paired with the publish-gate's >=95% test+eval pass)
- `8-9` → **community-tier eligible**, doctor prints paste-ready fixes for the misses
- `5-7` → **experimental-tier only**, doctor lists required fixes
- `<5` → doctor refuses to score, prints "this isn't a skillpack yet — run `gbrain skillpack init` and try again"

**2. Layered doctor — `gbrain skillpack doctor`**

Two modes; the agent picks which one based on workflow phase:

```
gbrain skillpack doctor <pack-dir|tgz> [--quick|--full] [--fix] [--json]
```

- `--quick` (default): structural-only sweep. Walks the rubric. ~5
  seconds. No sandbox, no LLM, no DB. The right command during
  iteration — save a file, run doctor, see your new score.
- `--full`: equivalent to `gbrain skillpack pack --dry-run` — runs the
  sandbox, the tests, the LLM-judge evals, the routing-evals against a
  trial install, the security gates. ~minutes. The right command
  before invoking the publish skill.
- `--fix`: auto-scaffold missing pieces. Calls `gbrain skillify
  scaffold` for missing skills, drops runbook stubs from templates,
  generates a CHANGELOG entry from VERSION + git log. **Destructive on
  the file tree**: prints `"this will create the following N files,
  proceed? [y/N]"` confirm prompt; non-TTY requires explicit `--yes`.
  Refuses to overwrite any file whose mtime is newer than the
  manifest's modified-at (heuristic for "user hand-edited this").
- `--json`: stable JSON envelope for agent consumption.

JSON output (the agent contract):

```json
{
  "schema_version": "skillpack-doctor-v1",
  "skillpack": "hackathon-evaluation",
  "version": "0.1.0",
  "mode": "quick",
  "score": 7,
  "max_score": 10,
  "tier_eligibility": "community-with-fixes",
  "dimensions": [
    {"id": 1, "name": "manifest_valid", "score": 1, "fix_hint": null},
    {"id": 7, "name": "llm_eval_present", "score": 0,
     "fix_hint": "gbrain skillify scaffold-eval <skill-name>",
     "auto_fixable": true}
  ],
  "next_action": "Run: gbrain skillpack doctor --fix to scaffold the 3 missing pieces, then re-run."
}
```

**Agent guidance (lives in `docs/skillpack-anatomy.md` AND in
`skills/_brain-filing-rules.md`):**

- After every meaningful edit during pack development: `gbrain
  skillpack doctor --quick --json`. Target a 10/10 before ever invoking
  `pack --dry-run`.
- Before publishing: `gbrain skillpack doctor --full` to catch what the
  structural pass can't.
- If doctor flags `auto_fixable: true` dimensions, the agent runs
  `gbrain skillpack doctor --fix --yes` and re-runs `--quick`.

**Required core vs quality-badge dimensions (codex outside-voice T4):**

Per the codex review's stub-spam concern, the rubric splits into
**required for publish** (5 dimensions, the v1 floor) and **quality
badges** (5 dimensions, earn-them-for-tier-eligibility). A pack with
0 badges still publishes as `experimental`; it just shows visible
"no-badges" flags in the registry so consumers can decide.

| Tier            | Required core (must pass) | Badges (must earn) |
|-----------------|---------------------------|--------------------|
| `experimental`  | 1, 2, 3, 5, 10            | 0                  |
| `community`     | 1, 2, 3, 5, 10            | + at least 3 of {4, 6, 7, 8, 9} |
| `endorsed`      | 1, 2, 3, 5, 10            | + ALL of {4, 6, 7, 8, 9} |

Required core (5 dimensions): manifest_valid, skills_have_skill_md,
routing_evals_present (>=5 intents per skill), check_resolvable_clean,
changelog_present_and_current. Quality badges (5 dimensions):
routing_evals_clean (LLM-judge layer), unit_tests_present,
llm_eval_present, install_runbook_present, uninstall_runbook_present.

The doctor still reports a 10/10 score (badges are display +
tier-gating, not rubric-replacement). A publisher who stubs all 5
badges with empty fixtures gets a visible "stubbed-eval-detected"
flag from the publish-gate's content scan (e.g., 0 unique assertion
strings in an eval, or a passing test with no `expect()` calls).
Cathedral scaffold from `gbrain skillpack init` still drops all 10
dimensions by default; the floor for publish is lower.

**3. Reference pack + anatomy doc**

- `examples/skillpack-reference/` — a real, working **10/10 pack**
  living in the gbrain repo. Doubles as an integration-test fixture for
  the doctor + publish-gate test suite. Includes 2 skills, 2
  routing-eval.jsonl files, 3 unit tests, 1 LLM-judge eval, full
  runbook set, CHANGELOG. `bun run build` includes
  `cd examples/skillpack-reference && gbrain skillpack doctor --quick`
  as a pre-commit assertion so the reference pack never regresses.
- `docs/skillpack-anatomy.md` — one-page reference. Tree diagram +
  rubric table + paste-ready commands. Auto-generated from
  `src/core/skillpack/rubric.ts` via `bun run build:skillpack-anatomy`.
  Diagram + tree are hand-curated; rubric table is machine-generated;
  CI fails if generated section is out of sync.

**4. Invariant: every gbrain-shipped skillpack scores 10/10**

The bundled gbrain skillpack (today's `openclaw.plugin.json` set, plus
any future bundles like `starter-pack`, `founder-pack`) MUST score
10/10 on `gbrain skillpack doctor --quick`. This is a regression
guard, not a target:

- `scripts/check-bundled-skillpacks-rubric.sh` runs in CI and
  `bun run verify`. Iterates every pack the gbrain repo ships and runs
  `gbrain skillpack doctor --quick --json`, asserts every score is 10.
- New gbrain releases that drop a bundled-pack score below 10 fail
  CI loud. The cost of fixing is a few `gbrain skillify scaffold`
  calls; the cost of skipping is that gbrain ships skillpacks that
  fail the bar gbrain demands of third parties — credibility-poison.
- Today's openclaw.plugin.json set is not yet at 10/10 (no per-skill
  unit tests, no LLM-judge evals, no runbooks). **Bringing it to 10/10
  is in-scope for v1 — wave W4.5** (added below).

### Scaffold: `gbrain skillpack init <name>` (cathedral defaults)

Lands the complete tree out of the box. `gbrain skillpack pack --dry-run`
on the scaffold passes immediately; developer deletes what they don't
need.

```
hackathon-evaluation/
├── skillpack.json                # filled with stubs + this version
├── skills/
│   └── hackathon-evaluation/
│       ├── SKILL.md              # frontmatter + example triggers
│       └── routing-eval.jsonl    # 5 example intents
├── test/
│   └── example.test.ts           # one passing unit test importing the skill helper
├── e2e/
│   └── example.e2e.test.ts       # one E2E skeleton, marked skip-if-no-DB
├── evals/
│   └── hackathon-evaluation.judge.json  # one cross-modal LLM-judge example
├── runbooks/
│   ├── install.md                # commented stub showing all 3 step kinds
│   ├── uninstall.md              # commented stub
│   └── upgrade-template.md       # rename to upgrade-<from>-to-<to>.md on first version bump
├── CHANGELOG.md                  # v0.1.0 entry pre-filled
├── README.md                     # for humans
├── LICENSE                       # MIT default
└── .gitignore                    # tarball outputs, node_modules
```

Boil-the-lake default. Same pattern as `gbrain init` which seeds
configuration + storage tiers + a starter source instead of asking
the user 15 questions.

### Slug collision: auto-suffix, agent-resolves

Agents are the primary installer. Forcing them to pick a side on every
collision adds friction without adding safety. Auto-resolve instead:

- **Flat namespace, auto-suffix on collision.** When the incoming pack
  ships a slug already claimed by a different installed source, the
  installer appends `-2` (then `-3`, etc.) to the incoming slug and
  proceeds. Loud stderr line: `[skillpack] renamed
  judge-submission → judge-submission-2 (collides with hackathon-judging)`.
- **Suffix is durable, not cosmetic.** The renamed slug goes into the
  source's per-source `cumulative-slugs` receipt AND a sibling
  `rename-map="judge-submission:judge-submission-2,..."` attribute on the
  source sub-header. Uninstall reads the rename map and removes the
  suffixed file + row, never the original.
- **Triggers (the user-facing routing surface) are untouched.** Slugs are
  identifiers; agents route via the SKILL.md `triggers:` frontmatter and
  the RESOLVER.md description column. A renamed slug still matches the
  same user phrases.
- **Reserved suffix range.** `-2..-99` is the auto-rename range. A pack
  authored with `judge-submission-2` as its own canonical name (rare)
  still installs fine; collision logic only fires on the bare-name
  collision, and a subsequent collision on `judge-submission-2` itself
  walks to `-3`. The collision-walk is bounded at `-99` and fails loud
  beyond that (defensive cap; you don't have 99 packs shipping the same
  slug).

No changes needed in `check-resolvable`, `routing-eval`, or
`filing-audit` — they all parse whatever slug they see, no namespacing
required.

### Install state: `~/.gbrain/skillpack-state.json` (codex G1)

The DX-review-locked design had TOFU SHA-256, pinned commit, rename
maps, and per-source receipts living inside markdown comments in the
RESOLVER.md managed block. Codex flagged that as a fragile trust
store — any agent or human edit to the resolver file silently
corrupts provenance. v1 fix: **split human-readable rows from machine-
owned state**.

- `~/.gbrain/skillpack-state.json` (machine-owned, agent-readable):
  the source of truth for TOFU SHA-256, pinned commit, source URL,
  rename map, install timestamp, version, tier_when_installed,
  endorsement-tier-at-install. One entry per installed source.
  Atomic update via `.tmp` + `rename()`. Read on every install /
  uninstall / update; resolver block is rendered from this.
- Resolver-block sub-headers (in RESOLVER.md / AGENTS.md) carry only
  human-readable identity: `name`, `version`, `tier`, and the
  cumulative-slugs list (still needed for uninstall to know what to
  remove without consulting state.json — defense in depth against a
  corrupted state.json). Receipt comment shape:
  `<!-- gbrain:skillpack:source name="..." version="..." tier="..." cumulative-slugs="..." -->`.
- Mismatch between state.json and resolver-block (e.g., resolver lists
  a source not in state.json, or state.json's cumulative-slugs differs
  from the rendered rows) fails loud at install-time and refuses
  further mutations until reconciled by `gbrain skillpack reconcile`.
- Schema: `skillpack-state.json` has `schema_version:
  "gbrain-skillpack-state-v1"` for forward-compat; mirrors the
  installer.ts cumulative-slugs receipt evolution story.

### Resolver-block: one block per source

The managed block in RESOLVER.md / AGENTS.md grows a **source-keyed**
sub-section header so multiple packs can coexist without rewriting the
whole block on every install. Cumulative-slugs receipt is per-source:

```markdown
<!-- gbrain:skillpack:begin -->
<!-- gbrain:skillpack:source name="gbrain" version="0.36.0.0" cumulative-slugs="ingest,query,..." -->
| ingest | ... |
| query  | ... |
<!-- gbrain:skillpack:source name="hackathon-evaluation" version="0.1.0" cumulative-slugs="judge-submission-2,score-rubric" pinned-commit="abc1234" rename-map="judge-submission:judge-submission-2" tofu-sha256="deadbeef..." -->
| judge-submission-2 | Judge a hackathon submission against the YC rubric. |
| score-rubric       | ... |
<!-- gbrain:skillpack:end -->
```

`tofu-sha256` is the resolved-commit SHA (git source) or tarball SHA-256
(tarball source). Re-install / update compares the new resolution against
the recorded value; mismatch = re-prompt (TTY) or refuse without
`--update` (non-TTY).

Per-source receipt means uninstalling one pack doesn't touch another pack's
rows or D11 hash budget.

### Trust posture

- **Default**: TOFU. First install of a given repo URL prompts via
  `AskUserQuestion`-equivalent CLI flow ("you are about to install
  skillpack `<name>` from `<url>` at commit `<sha>`. Trust this source?").
  TTY-only; non-TTY requires explicit `--trust` flag.
- **Pin the commit SHA** into the per-source resolver receipt. Re-install
  / upgrade refuses to silently advance the SHA without user consent (same
  prompt or `--update`).
- **`--allow-private-remotes`** flag pipes through to `git-remote.ts`'s
  `GBRAIN_ALLOW_PRIVATE_REMOTES` for internal/Tailscale skillpacks.
- Signing (minisign / cosign) is a v2 escape hatch; not in scope for v1.

### CLI surface

```
gbrain skillpack install <source> [--update] [--trust] [--allow-private-remotes] [--dry-run] [--json]
gbrain skillpack list [--source <name>] [--json]
gbrain skillpack uninstall <name> [--overwrite-local] [--dry-run]
gbrain skillpack info <name>                 # NEW: show pinned commit, author, license, renames
gbrain skillpack update [<name>] [--check]   # NEW: check for upstream commits
gbrain skillpack init <name>                 # NEW: scaffold publisher repo
gbrain skillpack pack [--out <path>]         # NEW: validate + emit .tgz tarball
```

`<source>` accepts:
- `garrytan/repo` → `https://github.com/garrytan/repo.git`
- `https://github.com/.../...git` → verbatim, SSRF-checked
- `./path/to/pack.tgz` → tarball; extract to cache, install from tree
- `./path/to/repo` → local filesystem dir (for skill authors testing
  locally; same trust posture as today's `--skills-dir`)

### Publisher workflow (the "make a skillpack" path)

1. `gbrain skillpack init <name>` — scaffolds `skillpack.json` +
   `skills/` + `RESOLVER.md` (skillpack-internal) + `.gitignore`.
2. Author writes skills using existing `gbrain skillify scaffold` patterns.
3. `gbrain skillpack pack --dry-run` — runs the full validate pipeline:
   - `skillpack.json` schema check
   - every listed skill has SKILL.md + valid frontmatter
   - `gbrain check-resolvable` clean
   - `gbrain routing-eval` clean (structural layer)
   - no banned file types in any skill dir (no `.env`, `.ssh`, executables)
   - returns structured pass/fail JSON
4. `git push` to publish. Distribution is the git remote.

## Critical files to add / modify

### New

- `src/core/skillpack/manifest-v1.ts` — Zod-equivalent runtime
  validator for `skillpack.json`. Owns the `SkillpackManifest` type.
- `src/core/skillpack/remote-source.ts` — wraps `git-remote.ts` for the
  skillpack use case: shallow clone to a cache dir under
  `~/.gbrain/skillpack-cache/<host>/<owner>/<repo>/<sha>/`, resolves
  HEAD SHA, supports update via `pullRepo`.
- `src/core/skillpack/tarball.ts` — `packTarball(dir, outPath)` +
  `extractTarball(tgzPath, cacheDir)`. Tar entries validated against
  allowlist (no symlinks, no executables, no traversal). SHA-256
  computed on the gzipped output for TOFU pinning.
  **Deterministic tarball spec (codex outside-voice gap):** SHA-256
  is only stable if the tarball is byte-deterministic. The packer
  enforces: (a) entries sorted by path (lexicographic), (b) all
  mtimes fixed to `1970-01-01T00:00:00Z` (or the commit's mtime if
  available, but reproducibly), (c) uid=0/gid=0, mode normalized
  (0644 for files, 0755 for directories), no pax headers, (d) gzip
  with `mtime=0`, no original-filename header. Reject on extract:
  symlinks, hardlinks, device files, FIFOs, any non-regular non-
  directory entry. Caps on extract: max 5000 files, max 100MB
  decompressed total, max 1MB per file, max path length 255 chars,
  max compression ratio 100:1 (compression-bomb defense). Pinned by
  `test/skillpack-tarball-determinism.test.ts` (pack the same dir
  twice on different days → same SHA).
- `src/core/skillpack/collision-resolver.ts` — pure function
  `resolveSlugCollisions(incoming: string[], existing: Set<string>): {
  finalSlugs: string[], renameMap: Record<string,string> }`. Bounded
  walk to `-99`. Pinned by unit tests.
- `src/core/skillpack/multi-source-receipt.ts` — parse + serialize the
  per-source resolver-block sub-headers. Pure functions; pinned by tests.
- `src/core/skillpack/trust-prompt.ts` — TOFU prompt + TTY/non-TTY
  branching. Mirrors v0.32.4 install-picker prompt shape.
- `src/core/skillpack/registry-client.ts` — fetch + cache the live
  `registry.json` over HTTPS. Honors `If-None-Match` etag for cheap
  polling. Validates schema before use. Caches under
  `~/.gbrain/skillpack-cache/registry-<sha256-of-url>.json` with a
  1-hour soft TTL.
  **Offline-safe**: on fetch failure (network down, GitHub 5xx, DNS
  miss), falls back to the on-disk cache and emits a single stderr
  line per process: `[skillpack] registry fetch failed, using cache
  from <fetched_at> (N hours old)`. If cache is >7 days old, the
  warning escalates to `cache is stale, run 'gbrain skillpack registry
  --refresh' when back online`. Hard-fail only when there is no cache
  at all (first-run + offline). `--no-cache` flag forces network and
  fails loud on miss. The cache file's `fetched_at` is wall-clock
  time; clock skew is non-issue because we never compare cached
  fetched_at against the registry's `updated_at` for freshness — only
  against current wall-clock for age display.
- `src/core/skillpack/registry-schema.ts` — runtime validators for
  `registry.json` + `endorsements.json` shapes. Single source of truth
  used by both `gbrain skillpack search` and the publish-gate skill.
- `src/core/skillpack/sandbox.ts` — **subprocess-isolated** trial-install
  harness with a per-platform fallback chain.
  - **Linux**: `bwrap → unshare → docker`. Tries `bwrap` (bubblewrap)
    first — most portable, on every recent distro's repo, ~100ms
    spinup. Falls back to `unshare --net + --mount` when bwrap is
    missing but the kernel allows unprivileged user namespaces (covers
    stock Debian/Ubuntu/Arch). Falls back to `docker run --rm
    --network=none --volume <tempdir>:/work --workdir /work` for
    RHEL/Rocky/CentOS where unprivileged userns is disabled by
    sysctl. Pure-tree: no minimal Linux image without bwrap AND without
    docker — fails loud with a paste-ready apt/yum install hint.
  - **macOS**: `sandbox-exec → docker`. Tries Apple's built-in
    `sandbox-exec` first with a per-publish `.sb` profile (filesystem
    write confined to tempdir, network denied, no IPC). ~50ms spinup.
    Falls back to Docker Desktop only when `sandbox-exec` is unavailable
    (rare; Apple keeps deprecating it but hasn't pulled it). macOS
    publishers without Docker can still publish via sandbox-exec.
  - Inside the sandbox, an ephemeral in-memory PGLite gbrain runs the
    trial install, reuses the pattern from
    `src/eval/longmemeval/harness.ts`. Exposes
    `runTrialInstall(packPath, opts): Promise<TrialResult>` consumed
    by the publish-gate.
  - Bun's `child_process` spawn with the chosen backend's wrapper
    argv; abort signal kills the wrapper which cascades to the child.
  - **Env scrub (codex G2):** the spawned process inherits a CLEAN
    env (only `PATH`, `LANG`, `TZ` pass through). Explicitly stripped:
    `GITHUB_TOKEN`, `GH_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
    `VOYAGE_API_KEY`, `GROQ_API_KEY`, all `*_API_KEY` / `*_TOKEN` /
    `*_SECRET` variables, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`,
    `GIT_*` (no GIT_ASKPASS, no GIT_SSH), `NPM_TOKEN`,
    `BUN_INSTALL_TOKEN`, plus an explicit denylist defined as a
    pure-function constant in `src/core/skillpack/sandbox-env.ts`.
  - **HOME override**: `HOME=<tempdir>/sandbox-home` (empty dir).
    Side effects: no `~/.gbrain` access, no `~/.gitconfig` (credential
    helper disabled), no `~/.netrc`, no `~/.npmrc`, no
    `~/.bunfig.toml`. The publish-gate's PGLite + LLM-judge stubs
    were already designed to not need real credentials; this just
    enforces it.
  - **Read-only mounts** (bwrap / docker; sandbox-exec uses
    deny-write profiles): only the pack tempdir is read-write; every
    other path is read-only or unmounted. `/proc` masked where bwrap
    supports it (`--proc /proc --new-session`).
  - Pinned by `test/skillpack-sandbox-env-scrub.test.ts`: 8 cases
    asserting each known-credential env var is stripped, HOME is
    overridden, the denylist constant matches the test fixture.
- `src/core/skillpack/sandbox-profiles/macos.sb` — sandbox-exec policy
  file (allow read/write only within `${TEMPDIR}`, deny network, deny
  process-fork beyond the trial-install Bun process, deny mach lookups
  except the minimum set Bun needs to start).
- `src/core/skillpack/sandbox-probe.ts` — pre-flight: detects which
  sandbox backend is available, in order. Emits a structured
  `SandboxBackend = 'bwrap' | 'unshare' | 'sandbox-exec' | 'docker' |
  'none'` discriminator. Backend choice persists per-process (avoid
  re-probing on every trial). `gbrain doctor` surfaces the chosen
  backend as info.
- `src/core/skillpack/security-gates.ts` — static-analysis pipeline.
  `runShellcheck(files)` (shells out if shellcheck is installed; degrades
  to a built-in regex pass naming the offending patterns when not),
  `scanForbiddenFiletypes(tree)`, `validateExternalResources(skill)`,
  `checkFrontmatter(skill)`. Each returns structured findings.
- `src/commands/skillpack-init.ts` — `gbrain skillpack init <name>`
  scaffold command.
- `src/commands/skillpack-pack.ts` — `gbrain skillpack pack` validator
  AND tarball emitter. Single command, `--dry-run` skips the tarball.
- `src/commands/skillpack-info.ts` + `skillpack-update.ts`.
- `src/commands/skillpack-search.ts` — `gbrain skillpack search <query>
  [--tier ...] [--json]` reads the registry, ranks by tier then tag
  match, prints a table.
- `src/commands/skillpack-registry.ts` — `gbrain skillpack registry
  [--url X] [--refresh]` show/set the configured registry URL,
  optionally force a fresh fetch.
- `src/commands/skillpack-endorse.ts` — `gbrain skillpack endorse <name>
  [--tier endorsed|community|experimental] [--push] [--dry-run]`. Runs
  in a clone of the registry repo; validates `<name>` against
  `registry.json`; reads, updates, schema-validates, and writes
  `endorsements.json` with stable key ordering; stages + commits with a
  one-line conventional-commit message `endorse: <name> -> <tier>`;
  optionally pushes. Refuses if not inside a registry-shaped repo.
- `src/core/skillpack/runbook-parser.ts` — parses
  `runbooks/install.md`, `uninstall.md`, and `upgrade-*.md` files.
  Validates frontmatter (`runbook_kind`, `gbrain_version_range`,
  `skillpack`, `skillpack_version`, plus `from_version`/`to_version`
  for upgrades). Tokenizes each numbered step as one of three kinds:
  `agent:` / `show user:` / `ask user:`. Returns a strongly-typed
  `Runbook` value. Pure function; pinned by unit tests with malformed-
  runbook fixtures.
- `src/core/skillpack/runbook-walker.ts` — executes a parsed runbook
  against a calling context. Dispatches each step kind: `agent:` runs
  the gbrain CLI subcommand (only gbrain CLI; not arbitrary shell);
  `show user:` writes to stdout; `ask user:` blocks on a TTY confirm
  (non-TTY requires a `--yes` flag and refuses-confirmation steps
  cause failure). Returns a structured `RunbookResult` so callers can
  see which steps ran. Test seam: `opts.shellTransport` lets tests
  drive without real subprocess spawn.
- `src/core/skillpack/upgrade-planner.ts` — given the resolver
  receipt's recorded `skillpack_version` for a pack and the new
  version's `upgrade-*.md` set, computes the upgrade walk path
  (e.g., v0.1 → v0.3 might walk `upgrade-0.1-to-0.2.md` then
  `upgrade-0.2-to-0.3.md`). Refuses if no path exists; refuses to
  downgrade silently; pure function.
- `src/commands/skillpack-test.ts` — `gbrain skillpack test [pack-dir]`
  runs the publisher-side full test+eval suite OUTSIDE the publish
  gate so a publisher can iterate fast before invoking the publish
  skill. Real gateway (publisher pays the real LLM cost on their
  machine, not the publish gate). Outputs the same JSON shape the
  publish gate's validation log uses, so the publisher sees exactly
  what the gate will see.
- `src/commands/skillpack-init.ts` (extended scope from earlier section)
  — scaffolds the full cathedral tree above. `--minimal` flag drops
  test/, e2e/, evals/ for power users who explicitly opt out.
- `src/core/skillpack/rubric.ts` — declarative `SKILLPACK_RUBRIC_V1`
  array of `RubricDimension` (see schema above). Pure-data + check
  functions that take a parsed pack and return `{ passed: boolean,
  detail: string }`. Single source of truth for doctor + anatomy doc +
  tests.
- `src/core/skillpack/doctor.ts` — `runDoctor(pack, opts:
  {mode: 'quick' | 'full', fix: boolean, autoYes: boolean}):
  Promise<DoctorResult>`. Walks the rubric, dispatches each check,
  computes score + tier eligibility, emits paste-ready fixes. `--fix`
  path dispatches per-dimension auto-scaffold (calls `gbrain skillify
  scaffold` for missing skills, writes runbook stubs from a template
  baked into the bundle, generates CHANGELOG entries from VERSION +
  `git log --since=<last-version-tag>`). Refuses to overwrite files
  whose mtime is newer than `skillpack.json`'s mtime (heuristic for
  "hand-edited since last manifest update").
- `src/commands/skillpack-doctor.ts` — CLI wrapper. Reads flags,
  resolves the pack (file or dir or tarball), calls `runDoctor`,
  formats JSON or human output. Exit codes: 0 if score=10, 1 if score
  6-9, 2 if score 0-5 or refused.
- `scripts/build-skillpack-anatomy.ts` — generates the
  rubric-table section of `docs/skillpack-anatomy.md` from
  `src/core/skillpack/rubric.ts`. `bun run build:skillpack-anatomy`.
  CI guard `scripts/check-anatomy-fresh.sh` runs in `verify` to detect
  drift between rubric and committed doc.
- `scripts/check-bundled-skillpacks-rubric.sh` — CI guard. Walks every
  bundled skillpack (today: `openclaw.plugin.json` set; future:
  any `examples/skillpack-*` and any bundled starter pack), runs
  `gbrain skillpack doctor --quick --json` against each, asserts
  score=10. Fails the build loud on regression. Wired into
  `package.json`'s `verify` script.

### New (in github.com/garrytan/gbrain repo, examples + docs)

- `examples/skillpack-reference/` — a real, working **10/10 reference
  skillpack** that lives in the gbrain repo. Two skills, 2
  routing-eval.jsonl files (5 intents each), 3 unit tests, 1
  LLM-judge eval (3 cases), full runbooks (install / uninstall /
  upgrade-template), CHANGELOG, README, LICENSE. The reference
  pack is the integration-test fixture for the doctor + the
  publish-gate full-suite E2E test, AND it's what `gbrain skillpack
  doctor --quick` is regression-tested against.
- `docs/skillpack-anatomy.md` — one-page agent + human reference.
  Contains: (a) tree diagram of the cathedral scaffold, (b) auto-
  generated rubric table from `rubric.ts`, (c) paste-ready commands
  for every step from `init` → `doctor --quick` → `doctor --fix` →
  `pack --dry-run` → `publish`. Auto-generated header + manual prose
  + auto-generated rubric body; a marker block guards the generated
  section.
- `src/core/skillpack/audit.ts` — JSONL audit at
  `~/.gbrain/audit/skillpack-YYYY-Www.jsonl` (ISO-week rotated, mirrors
  `src/core/audit-slug-fallback.ts` + `src/core/rerank-audit.ts`).
  `logSkillpackEvent({event, source_kind, name, version,
  pinned_commit, tier_when_installed, outcome, error?})` called by
  install / uninstall / update / search-resolve paths. Best-effort —
  never throws, logs stderr warning on write failure.
  `readRecentSkillpackEvents(days)` is the readback path for `gbrain
  doctor`'s new `skillpack_activity` check (info-level: "installed N
  packs in the last 7 days, all from endorsed tier" or "installed 2
  community-tier packs in the last 24h — review at <audit-path>").
- `skills/gbrain-skillpack-publish/SKILL.md` — the publish-gate skill
  itself. Lives in the bundled skillpack so every gbrain install ships
  with it. Walks the contributor through:
  1. Validate locally (`gbrain skillpack pack --dry-run`)
  2. Run security gates
  3. Pack tarball + compute SHA
  4. Fork `garrytan/gbrain-skillpack-registry` if needed (`gh repo fork`)
  5. Branch, append catalog entry, commit validation-run JSON
  6. Push + open PR via `gh pr create`
  7. Print the PR URL and remind the contributor "Garry endorses
     separately; check back for the tier flip."

### New (in github.com/garrytan/gbrain-skillpack-registry, separate repo)

- `registry.json` — the catalog (schema above)
- `endorsements.json` — Garry-only file controlling the `endorsed` tier
- `validation-runs/<run-id>.json` — one file per published validation,
  immutable, content-addressable. Anyone auditing a skillpack can pull
  the corresponding run JSON.
- `tarballs/<name>-<version>.tgz` — registry-mirrored tarball, written
  by CI at PR-merge time as the durable copy. Each tarball is
  content-addressed by the SHA-256 already recorded in `registry.json`.
  Tarballs use **git LFS** to keep the registry clone small (a 1GB
  registry would be miserable to clone). Per-pack soft cap of 5MB;
  packs larger than 5MB are stored as link-only (the registry entry
  records a `source_only: true` flag and skips the tarball mirror).
- **CI durability job** (`.github/workflows/mirror-tarball.yml`): on
  every PR merge, clones the pinned commit of the new entry, regenerates
  the tarball, verifies it matches the registry's recorded SHA-256, then
  commits to `tarballs/`. Belt-and-suspenders: if the source-repo SHA
  was a lie at PR-time, the mirror job fails loudly and the registry
  entry is reverted.
- **CI liveness job** (`.github/workflows/liveness-check.yml`): weekly,
  walks every registry entry and verifies the source URL still resolves
  to the pinned commit. Unreachable entries get a `last_alive: <date>`
  field but are NOT auto-tombstoned — Garry decides whether to deprecate.
- `README.md` — explains the tier system, links to the publish skill,
  documents how to fork + submit
- **Two-workflow CI split (codex G3)** — registry-side CI separates
  static-only PR validation from any dangerous execution:
  - `.github/workflows/validate-pr.yml` runs on **`pull_request`**
    (NOT `pull_request_target`). Permissions: `contents: read,
    pull-requests: read` only. NO GitHub token write scopes, NO LFS
    write, NO repo PAT. Does: manifest schema check, file-type
    allowlist scan, slug uniqueness vs `registry.json`, dependency
    declaration check. Pure static. Cannot exfiltrate anything because
    it has nothing to exfiltrate.
  - `.github/workflows/post-merge-validate.yml` runs on
    `push` to `main` with the new entry's commit. Permissions:
    `contents: write` (only for the new tarballs/ file). Executes the
    publish-gate's test + LLM-judge-stub + routing-eval suite inside
    the registry's own sandbox (same `bwrap`/`sandbox-exec` profile
    documented above; same env-scrub posture). If validation fails
    after merge, the workflow opens a follow-up PR reverting the
    registry entry and posts a comment naming the failure. Slow path
    but isolated.
  - `.github/workflows/mirror-tarball.yml` (third workflow): runs after
    `post-merge-validate.yml` passes, with a **deploy key** scoped to
    `tarballs/` only. Commits the SHA-256-verified tarball. Cannot
    write `registry.json`, `endorsements.json`, or anything outside
    `tarballs/`.
  - The standard supply-chain posture: PR-time = static, never
    executes contributor code. Post-merge = isolated, never has
    privileged tokens. Mirror commit = least-privilege deploy key.
- `bundles.json` (or a `bundles` section in `registry.json`) — named
  bundles like `starter-pack`, `founder-pack`, `journalist-pack`
- `test/skillpack-manifest-v1.test.ts`,
  `test/skillpack-multi-source-receipt.test.ts`,
  `test/skillpack-remote-source.test.ts`,
  `test/skillpack-collision-resolver.test.ts` (covers `-2` walk, the
  pack-authored-`-2` corner case, the `-99` cap),
  `test/skillpack-tarball.test.ts` (round-trip, allowlist enforcement,
  symlink rejection, SHA-256 stability),
  `test/skillpack-pack.test.ts`,
  `test/skillpack-registry-client.test.ts` (etag handling, schema
  rejection on malformed registry, stale-cache behavior, network-down
  graceful fallback to last good cache),
  `test/skillpack-registry-schema.test.ts` (every tier valid, missing
  required field caught, unknown tier rejected),
  `test/skillpack-search.test.ts` (tier ordering, tag rank, JSON shape),
  `test/skillpack-sandbox.test.ts` (trial install creates + tears down
  PGLite cleanly, network-disabled assertion fires),
  `test/skillpack-security-gates.test.ts` (forbidden filetypes caught,
  shellcheck path AND fallback regex path both work, external_resources
  declaration enforced),
  `test/e2e/skillpack-third-party.test.ts` (PGLite-only, no
  `DATABASE_URL` required; uses both a local-filesystem source fixture
  AND a local-tarball source fixture so both install paths are pinned),
  `test/e2e/skillpack-registry-install.test.ts` (PGLite-only; serves a
  fixture `registry.json` via a localhost HTTP harness, installs by
  short name, asserts the right pack lands; covers missing-pack-name
  error path and stale-pin error path),
  `test/skillpack-publish-preflight.test.ts` (T-GAP-1 from eng review:
  `gh not installed` AND `gh not authed` both surface actionable
  errors with paste-ready install/login commands),
  `test/skillpack-sandbox-network-block.test.ts` (T-GAP-2 from eng
  review: synthetic pack inside sandbox attempts `fetch(...)` and
  `https.request(...)` — both must be rejected by the chosen backend.
  Runs against every sandbox backend the test host can spin up; skips
  gracefully when a backend is unavailable.),
  `test/e2e/skillpack-bundle-atomicity.test.ts` (T-GAP-3 from eng
  review: 5-pack starter-pack fixture where pack #3 has a synthetic
  failure; asserts per-pack-independent contract — packs 1-2 land,
  pack-3 reported failed, packs 4-5 skipped, retry hint printed,
  managed block intact for packs 1-2 only),
  `test/skillpack-uninstall-renamed.test.ts` (T-GAP-4 from eng review:
  install pack-A with `judge-submission`, install pack-B which
  auto-renames to `judge-submission-2` via the rename map. Uninstall
  pack-B and assert it removes the `-2` row, not the bare-name row.
  Then uninstall pack-A and assert clean state),
  `test/skillpack-runbook-parser.test.ts` (frontmatter validation,
  three step kinds parsed correctly, malformed runbook fails loud,
  upgrade-runbook frontmatter requires from_version + to_version),
  `test/skillpack-runbook-walker.test.ts` (each step kind dispatches
  to the right handler; `ask user:` honors --yes in non-TTY; refused
  confirmation halts the walk and reports which step refused; agent
  step that fails halts the walk and surfaces the failing CLI exit
  code),
  `test/skillpack-upgrade-planner.test.ts` (single-hop path v0.1->v0.2;
  multi-hop path v0.1->v0.2->v0.3; refuses when no path exists;
  refuses silent downgrade),
  `test/skillpack-coverage-score.test.ts` (tier eligibility math:
  endorsed needs routing + runbooks + >=95%; community needs routing +
  install + >=80%; everything else falls to experimental),
  `test/e2e/skillpack-publish-gate-full-suite.test.ts` (PGLite-only;
  synthetic pack with declared unit tests + LLM-judge evals + routing
  evals, publish gate runs the suite inside the sandbox with stubbed
  gateway, produces validation log with coverage score, tier
  assignment matches expectations),
  `test/skillpack-rubric.test.ts` (every dimension in
  `SKILLPACK_RUBRIC_V1` has a check function that returns
  `{passed, detail}`; pure-function tests against fixture packs that
  pass / fail each dimension individually + a known-bad pack that
  triggers all 10 fixes simultaneously),
  `test/skillpack-doctor-quick.test.ts` (the `--quick` mode runs in
  < 1s on the reference pack; produces stable JSON envelope; refuses
  scores < 5; exit codes correct per band),
  `test/skillpack-doctor-fix.test.ts` (`--fix` scaffolds missing
  pieces; respects the mtime-vs-manifest heuristic and refuses to
  overwrite hand-edited files; confirm prompt fires on TTY;
  `--yes` skips it; non-TTY without `--yes` refuses),
  `test/e2e/skillpack-reference-is-ten.test.ts` (regression guard:
  `gbrain skillpack doctor --quick --json examples/skillpack-reference`
  always scores 10/10; if a future PR drops the reference pack
  below 10, this test fails loud and CI rejects),
  `test/skillpack-anatomy-fresh.test.ts` (asserts
  `scripts/check-anatomy-fresh.sh` passes: the rubric section of
  `docs/skillpack-anatomy.md` matches what
  `bun run build:skillpack-anatomy` would emit from the current
  rubric.ts; future-edit-of-rubric without doc-regen fails the build).

### Modified

- `src/commands/skillpack.ts` — extend `install` to dispatch on source
  shape (bundled vs `owner/repo` vs URL vs local path).
- `src/core/skillpack/installer.ts` — thread a `source: {name, version,
  pinnedCommit?}` discriminator through `applyInstall` / `applyUninstall`.
  Read + write per-source managed sub-blocks.
- `src/core/skillpack/bundle.ts` — accept either today's
  `openclaw.plugin.json` shape OR the new `skillpack.json`, normalize
  internally so the rest of the pipeline doesn't care.
- `src/commands/skillpack-check.ts` — surface per-source health in the
  agent-readable report.
- `CLAUDE.md` Key Files section.
- New `docs/skillpack-authoring.md` — the human-readable spec for
  publishers (not a marketing doc; reference doc).
- `docs/skillpack-distribution.md` — registry-shape discussion +
  versioning policy.

## Verification

End-to-end:

1. **Publisher path**: `gbrain skillpack init hackathon-evaluation` in a
   tempdir → add a synthetic skill → `gbrain skillpack pack --dry-run`
   → expect pass.
2. **Install from local path**: `gbrain skillpack install <tempdir>` in
   a fresh workspace → resolver-block shows the new source sub-block →
   `gbrain check-resolvable` clean.
3. **Install from git** (E2E, optional): clone a known-good public
   sample repo → same assertions.
4. **Multi-pack coexistence**: install the bundled gbrain set AND the
   sample skillpack into the same workspace → both rows present in the
   managed block, neither's cumulative-slugs receipt touches the other.
5. **Collision auto-rename**: install a second pack that ships a slug
   already present (`judge-submission`) → installer auto-suffixes to
   `judge-submission-2`, emits a stderr line, records the rename in the
   source receipt. Triggers still match the same user phrases.
6. **Uninstall safety**: edit one skill file in the third-party pack →
   `gbrain skillpack uninstall hackathon-evaluation` → refuses without
   `--overwrite-local` (D11 contract holds across sources).
7. **TOFU**: first-time install of a new URL prompts; second install of
   same URL + SHA does not.
8. **Registry resolution**: `gbrain skillpack install hackathon-evaluation`
   against a localhost-served fixture `registry.json` resolves the right
   git URL, verifies the pinned commit, lands the pack. Pin mismatch
   produces a loud refusal.
9. **Search**: `gbrain skillpack search yc --json` returns the entry,
   `endorsed` tier sorts before `community` sorts before `experimental`.
10. **Bundle install**: `gbrain skillpack install starter-pack` walks
    the bundle list in order; mid-bundle failure unwinds cleanly with
    no half-installed entries in the managed block.
11. **Publish-gate (sandbox)**: a synthetic skillpack with a forbidden
    file type (`.env`) AND a synthetic pack with a malicious shell
    script both get rejected by the publish-gate. A clean pack passes
    every gate and produces a tarball + SHA + PR-ready validation log.
12. **Trial install sandbox isolation**: the ephemeral PGLite the
    publish-gate spins up does NOT touch `~/.gbrain`. Tear-down is
    clean — no file artifacts, no DB connections left behind.
13. **Runbook execution end-to-end**: `gbrain skillpack install
    hackathon-evaluation` lands the pack AND walks
    `runbooks/install.md` step-by-step. Each `agent:` step runs;
    each `show user:` step prints; each `ask user:` step blocks on
    TTY confirm or honors `--yes`. Failed agent step halts the walk
    and surfaces the failing command.
14. **Upgrade walk multi-hop**: install pack@v0.1, publish v0.2 with
    `upgrade-0.1-to-0.2.md`, then v0.3 with `upgrade-0.2-to-0.3.md`.
    Upgrade from v0.1 directly to v0.3 walks BOTH runbooks in
    sequence. Mismatch between recorded version and available
    runbooks fails loud with paste-ready fix.
15. **Tier eligibility**: a pack with routing evals + runbooks +
    100% pass earns `endorsed` eligibility; same pack with one
    eval failing drops to `community`; pack with no routing evals
    drops to `experimental` regardless of other coverage.
16. **`gbrain skillpack test`** runs against a freshly-scaffolded
    pack and exits 0 (the scaffold's example tests pass out of the
    box, the example LLM-judge eval passes with the real gateway
    when `ANTHROPIC_API_KEY` is set, and `--no-llm` skips the
    LLM-judge path cleanly).

Tests:

- All unit tests pass: `bun run test`
- E2E gate: `bun run test:e2e` (Tier 1, no API keys)
- Typecheck clean: `bun run typecheck`
- `scripts/check-test-isolation.sh` clean (no new allowlist entries)

## Out of scope (deferred)

- Cryptographic signatures (minisign / cosign / Sigstore). The
  registry's content-hash pin + Garry-controlled endorsement file is the
  v1 trust posture; signatures are a v2 layer on top.
- Dependency resolution between skillpacks (`pack A depends on pack B`).
  v1 declares dependencies as informational metadata only.
- Versioning constraints richer than `gbrain_min_version` (no semver
  range matching, no `^0.36`).
- Auto-update / background pulls. `gbrain skillpack update` is manual.
- A central web UI (gbrain.dev/skillpacks). The registry repo's GitHub
  page IS the web UI in v1.
- Payment / monetization. Skillpacks are free / open source by default.
- Print-press CLI generation against gbrain HTTP MCP — explicitly IN
  scope per Q2 but listed here for clarity: it's a separate one-week
  effort that lives in a sibling branch, not blocking on the v1
  registry ship.

Each deferred item is an additive layer on the v1 design; none are
load-bearing for "Garry ships a hackathon-evaluation skillpack, gets it
listed in the registry, and someone discovers + installs it."

## Sequencing — what ships in what order

Six discrete waves. Each lands independently; later waves don't block
earlier ones from shipping value:

1. **W1: Single-pack install** — manifest schema, tarball pack, install
   from git URL / tarball / local path, multi-source resolver block,
   auto-rename collision resolver, TOFU prompt + commit pinning. Ships
   the floor: Garry can hand-distribute hackathon-evaluation today.
2. **W2: Registry catalog** — `garrytan/gbrain-skillpack-registry`
   created, `registry.json` schema + endorsements.json, registry-client
   with stale-cache fallback, `gbrain skillpack search` + `install
   <short-name>` + `info`. Initial catalog seeded with bundled gbrain
   skills + hackathon-evaluation + maybe one community pack.
3. **W3: Publish-gate skill** — `/gbrain-skillpack-publish` skill,
   security-gates module, sandbox-probe, subprocess-isolated trial
   install with Docker fallback on macOS. The contributor flow goes
   from "fork + commit + hope" to "run one skill, get a PR."
4. **W4: Audit + doctor integration** — `~/.gbrain/audit/skillpack-*`
   JSONL, `gbrain doctor` check, `gbrain skillpack history` reader.
5. **W5: Printing Press cross-list** — open the PR against
   `mvanhorn/printing-press-library` listing
   `garrytan/gbrain-skillpack-registry` as a sister registry. ~1 day.
6. **W6: Generated gbrain-cli (Printing Press)** — run printing-press
   against gbrain's HTTP MCP, ship the resulting agent-native CLI to
   their library. Independent week of work; doesn't block W1-W5.

**W4.5 — Bring bundled gbrain skillpacks to 10/10** (drops between W4
and W5, blocking on W3's doctor + rubric). The current
`openclaw.plugin.json` set is missing per-skill unit tests (most
have routing-eval.jsonl already from v0.19, missing LLM-judge evals
and per-skill runbooks). The CI guard
`scripts/check-bundled-skillpacks-rubric.sh` will fail the build
until every shipped pack scores 10. Effort: human ~3 days / CC ~3
hours across the ~25 bundled skills. Doctor's `--fix` auto-scaffold
reduces this to mostly "review the auto-generated stubs and fill in
the prose."

W1 is the floor for "Garry can ship hackathon-evaluation." W2 is the
floor for "anyone can discover it without reading Garry's README."
W3 is the floor for "anyone can publish without hand-running git."
W4-W6 are quality layers on a working system.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR (PLAN) | 6 proposals, 6 accepted, 0 deferred; EXPANSION mode |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 3 arch + 1 quality + 4 test-gap findings; 5 decisions locked |
| DX Review | `/plan-devex-review` | Developer experience gaps | 2 | CLEAR (PLAN) | 8 decisions across 2 rounds: artifact cathedral + rubric/doctor/anatomy + 10/10 bundled invariant |
| Codex Review | `/codex` plan-consult | Independent 2nd opinion | 1 | ISSUES_FOUND → INCORPORATED | 20 findings; 8 surfaced as tensions/gaps; 6 adopted (T1 + T4 + G1-G4); 2 cathedral defenses held (T2 scope, T3 10/10 invariant); 3 trailing correctness fixes folded in |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | no UI scope (CLI + skill markdown only) |

**Eng-review decisions locked this run:**
1. **Linux sandbox chain**: `bwrap → unshare --net → docker`. bwrap preferred (most portable, ~100ms); unshare covers stock kernels; docker as heavyweight fallback for RHEL/Rocky/CentOS where unprivileged userns is disabled.
2. **macOS sandbox**: `sandbox-exec → docker`. Apple's built-in `sandbox-exec` is the primary path (~50ms, no Docker dep); Docker is the rare fallback. macOS publishers without Docker can still publish.
3. **Bundle install atomicity**: per-pack independent (option γ). Failures inside a bundle leave earlier successful packs installed, skip later packs, print a summary with retry hint.
4. **Deleted source repo durability**: registry CI mirrors tarballs to `tarballs/<name>-<version>.tgz` via git LFS at PR merge time. 5MB per-pack cap; larger packs flagged `source_only: true`.
5. **Endorsement workflow**: `gbrain skillpack endorse <name> [--tier ...] [--push]` CLI command with schema validation; hand-editing remains valid.

**Eng-review findings (resolved by the 5 decisions above):**
- A1: Linux sandbox fallback chain underspecified → locked (#1).
- A2: Docker-on-macOS as a contributor cliff → locked (#2, sandbox-exec preferred).
- A3: Registry source-repo-deleted doom path → locked (#4, tarball mirror).
- C1: Bundle install atomicity unspecified → locked (#3).
- E1: Endorsement workflow unspecified → locked (#5).

**Test coverage:** 31/35 paths planned (~89%) before this review. Four gaps added to the plan as required tests before implementation:
- T-GAP-1: `gh` not-installed / not-authed branches in the publish skill.
- T-GAP-2: sandbox network-block assertion (fetch + https.request both rejected) across every backend the host can spin up.
- T-GAP-3: starter-pack bundle mid-failure (5-pack fixture, pack-3 fails) → per-pack-independent contract verified.
- T-GAP-4: uninstall a pack whose slug was auto-renamed via the rename map → `-2` row removed, not bare-name.

**Failure modes:** 0 critical gaps. Every new codepath is tested, rescued, AND user-visible. The collision-rename rollback path was the only silent-failure candidate; T-GAP-4 closes it.

**Worktree parallelization:** 6 lanes mapped via the W1–W6 sequencing in the plan.
- Lane A (W1: single-pack install): manifest, tarball, collision-resolver, multi-source-receipt, install paths. Sequential; shared `src/core/skillpack/` namespace.
- Lane B (W2: registry catalog): registry-client, registry-schema, search/info commands. Can run parallel to A after manifest schema lands.
- Lane C (W3: publish gate): publish skill, security gates, sandbox + sandbox-probe + macOS profile. Parallel to A+B but depends on tarball from A.
- Lane D (W4: audit + doctor): audit.ts + doctor check. Parallel to everything else.
- Lane E (W5: Printing Press cross-list): a single docs PR against `mvanhorn/printing-press-library`. ~1 day, fully independent.
- Lane F (W6: generated gbrain-cli): independent week of work; spawns its own branch.

Conflict flag: Lane A and Lane C both touch the in-tree skillpack module dir. Recommend serializing A → C within the same worktree.

**DX-review decisions locked across two rounds:**

*Round 1 — artifact scope:*
1. **Artifact scope: full cathedral.** `skillpack.json` declares `skills[]`, `unit_tests[]`, `e2e_tests[]`, `llm_evals[]`, `routing_evals[]`, `runbooks{install, uninstall, upgrades}`, `changelog`. The differentiation moat — nobody else ships AI evals + agent runbooks as first-class package artifacts.
2. **Publish gate runs everything in the sandbox.** Unit + E2E (when DB available) + LLM-judge (stubbed gateway, zero cost) + routing-evals. Coverage score drives tier eligibility: `endorsed` requires routing + runbooks + >=95% pass; `community` requires routing + install + >=80%; `experimental` accepts structural-only.
3. **Runbook format: agent-readable markdown** with three step kinds (`agent:`, `show user:`, `ask user:`). Separate `install.md`, `uninstall.md`, `upgrade-<from>-to-<to>.md` per version. Mirrors gbrain's own `skills/migrations/v0.21.0.md` pattern.
4. **`gbrain skillpack init` scaffolds the cathedral by default.** Full tree (skills, tests, e2e, evals, runbooks, CHANGELOG, README, LICENSE) lands out of the box; `gbrain skillpack pack --dry-run` passes immediately. `--minimal` flag for power users opting out.

*Round 2 — rubric + doctor + reference + invariant:*
5. **Layered doctor:** `gbrain skillpack doctor --quick` (~5s structural sweep, walks the rubric, no sandbox/LLM/DB) for rapid iteration; `--full` (runs the full publish-gate suite) for ship-readiness. Two-tool design; agent picks the mode per workflow phase. The user noted: agents do the operating, so the cognitive cost of two flags is irrelevant as long as the docs teach the agent when to use which.
6. **Rubric as declarative spec:** `src/core/skillpack/rubric.ts` exports `SKILLPACK_RUBRIC_V1` — 10 binary dimensions (manifest valid / SKILL.md complete / routing-evals present + clean / check-resolvable clean / unit test present / LLM-judge eval present / install + uninstall runbooks / CHANGELOG current). Single source of truth: doctor walks it, anatomy doc is auto-generated from it, tests pin each dimension.
7. **`doctor --fix` auto-scaffold:** Calls `gbrain skillify scaffold` for missing skills, drops runbook stubs, generates CHANGELOG entries from VERSION + git log. Confirm prompt on TTY; `--yes` skips; refuses to overwrite files whose mtime is newer than `skillpack.json`'s.
8. **Reference pack + anatomy doc + 10/10 invariant for EVERY bundled gbrain skillpack:** ship `examples/skillpack-reference/` (real working 10/10 pack) AND `docs/skillpack-anatomy.md` (one-page reference, auto-generated rubric section from `rubric.ts`). NEW INVARIANT (the user's strongest line): every gbrain-shipped skillpack must score 10/10 on `--quick`. `scripts/check-bundled-skillpacks-rubric.sh` is wired into `bun run verify` + CI. Bringing today's `openclaw.plugin.json` set to 10/10 is wave W4.5 — blocking on W3 (doctor) but required before v1.0 ship. Credibility-poison if gbrain ships skillpacks below the bar gbrain demands of third parties.

**DX scorecard (after both DX rounds):**

| Dimension          | Before | Round 1 | Round 2 | Notes |
|--------------------|--------|---------|---------|-------|
| Getting Started    | 4/10   | 9/10    | **10/10** | scaffold + `doctor --quick` round-trip in <10s; reference pack as ground truth |
| API/CLI/SDK        | 6/10   | 9/10    | **10/10** | `init / doctor / pack / test / publish / endorse / install / search` complete surface |
| Error Messages     | 5/10   | 8/10    | **9/10** | doctor emits paste-ready fix per failed dimension; auto-fixable flag for agents |
| Documentation      | 5/10   | 8/10    | **10/10** | `docs/skillpack-anatomy.md` is one-page + auto-generated rubric + reference pack as example |
| Upgrade Path       | 2/10   | 9/10    | **9/10** | runbook-walker handles multi-hop |
| Dev Environment    | 6/10   | 9/10    | **10/10** | `doctor --quick` (~5s) + `--fix` autoscaffold + `--full` (publish-gate) |
| Community          | 3/10   | 8/10    | **9/10** | registry + tarball mirror + endorsement workflow + reference pack to fork |
| DX Measurement     | 2/10   | 7/10    | **9/10** | doctor JSON envelope is stable; per-dimension scoring trend across publishes |
| **TTHW**           | n/a    | <5min   | **<3min** | `init` → edit → `doctor --quick` → 10/10 |
| **Overall DX**     | 4/10   | 8.5/10  | **9.5/10** | Rubric-as-source-of-truth + `every bundled pack is 10/10` invariant is the kill move |

**Magical moment** (locked from DX 0D): `gbrain skillpack install <name>` lands the pack AND walks `runbooks/install.md` AND the agent immediately knows what triggers fire, what tools the skill exposes, and how to upgrade later. Zero "where are the docs?" moment.

**Second magical moment** (Round 2): `gbrain skillpack doctor --quick --json` prints a 10/10 score with paste-ready fixes for the misses. The agent reads the JSON, runs `--fix --yes` to auto-scaffold, re-runs `--quick`, and the score climbs. The first time an agent gets from 6/10 to 10/10 in 30 seconds via three `gbrain` commands is the moment the "skillpacks are real software packages" claim becomes felt rather than asserted.

**Lake Score:** 25/27 — every cathedral-leaning recommendation accepted across CEO + Eng + DX (both rounds) + 8 codex outside-voice questions. The 2 holds are deliberate: T2 (kept cathedral scope vs codex's minimal v1) and T3 (kept the 10/10 bundled invariant vs codex's defer-to-v1.1). Both defenses were on locked product-strategy decisions; the cathedral moat is the thing.

**CODEX (outside voice) — 20 findings, 8 surfaced for decision:**
- T1 (RUNBOOK TRUST) — adopted: per-step approval replaces auto-walk; `--runbook-apply-all` for CI; `--runbook-skip` for file-drop-only. NPM-postinstall lesson applied.
- T2 (SCOPE) — held: cathedral is the moat; minimal v1 forfeits curation+evals+runbooks differentiation; without those gbrain skillpacks are just another agentskills.io mirror.
- T3 (10/10 BUNDLED) — held: shipping gbrain's own packs below the bar gbrain demands is credibility-poison; W4.5 retrofit costs ~3d with --fix autoscaffold, slips v1 by a week.
- T4 (GAMEABLE CATHEDRAL) — adopted: rubric splits into required core (5 dimensions: manifest + SKILL.md + routing-evals + check-resolvable + CHANGELOG) and quality badges (5: routing-evals-clean + unit tests + LLM-judge + install + uninstall runbook). Endorsed needs all badges; community needs 3/5; experimental needs core only. Plus stubbed-eval detection in publish-gate content scan.
- G1 (TRUST STORE) — adopted: `~/.gbrain/skillpack-state.json` machine-owned (TOFU pins, hashes, rename maps); resolver markdown stays render-only (rows + cumulative-slugs). Mismatch fails loud.
- G2 (ENV SCRUB) — adopted: clean env (only PATH/LANG/TZ), HOME override to empty `<tempdir>/sandbox-home`, explicit denylist (`*_API_KEY` / `*_TOKEN` / `*_SECRET` / SSH_AUTH_SOCK / GIT_* / NPM_TOKEN / BUN_INSTALL_TOKEN). Read-only mounts + masked `/proc` where bwrap supports it.
- G3 (CI SUPPLY CHAIN) — adopted: three-workflow split. validate-pr.yml is static-only on `pull_request` (no privileged tokens, no LFS write). post-merge-validate.yml runs the heavy suite inside the registry's own sandbox after merge. mirror-tarball.yml commits the tarball with a least-privilege deploy key scoped to `tarballs/`.
- G4 (NAMESPACE / TYPOSQUAT) — adopted: first-install identity confirm prompt showing author/source/commit/SHA/tier; subsequent same-author-same-pin installs skip. Registry rejects new endorsed-tier names within Damerau-Levenshtein edit-distance 2 of any existing endorsed pack.

**Trailing correctness fixes (no decision needed, codex gaps clearly worth taking):**
- Tarball determinism: sorted entries, fixed mtimes, gzip mtime=0, no symlinks/hardlinks/devices/FIFOs, extract caps (5000 files / 100MB total / 1MB per file / 255-char paths / 100:1 ratio).
- check-resolvable pack-local isolation: doctor + publish-gate wrap `check-resolvable` in a tempdir fixture containing ONLY the pack's RESOLVER.md + skills/, so verdict is pack-local not workspace-global.
- Versioning beyond `gbrain_min_version`: manifest also carries `runbook_schema_version` + `eval_schema_version`; installer rejects newer-than-supported with paste-ready upgrade hint.

**CROSS-MODEL TENSION (held cathedral over codex):**
- T2 scope and T3 bundled-invariant are product-strategy decisions where codex's argument (ship simpler v1 faster) lost to the user's argument (the differentiation IS the cathedral; shipping below your own bar is credibility-poison). Codex was right on every supply-chain finding; the disagreement on scope is taste, not correctness. Documented here so future maintainers see the trade.

**Recommended next reviews:**
1. **/codex consult** as an outside voice on the locked-in plan; the artifact-as-software-package framing deserves an independent challenge.
2. **/devex-review** after implementation lands — the boomerang. Plan says TTHW < 5min; reality check post-ship.

**UNRESOLVED:** none. CEO + Eng + DX (both rounds) + Codex outside-voice all clear with explicit decisions for every load-bearing item across 27 questions.

**VERDICT:** CEO + ENG + DX + CODEX CLEARED — ready to implement. The plan is a complete spec; the next move is implementation, not more review. Codex's 20 findings were absorbed (6 adopted as direct improvements, 2 held as taste-of-cathedral product calls, 12 minor / overlapping / already-covered). The two cathedral defenses are documented so future maintainers see the trade.
