---
name: skillpack-harvest
version: 0.33.0
description: |
  Lift a proven skill from a host repo (e.g. your OpenClaw fork) back into
  gbrain's bundle so other clients can scaffold it. Editorial workflow:
  the CLI does the file copy + privacy lint; this skill drives the
  judgment-heavy genericization (scrub real names, generalize triggers,
  lift fork-specific conventions to references).
triggers:
  - "harvest this skill into gbrain"
  - "publish this skill to gbrain"
  - "lift this skill upstream"
  - "share this skill with other gbrain clients"
  - "promote my skill to gbrain"
mutating: true
writes_pages: false
writes_to:
  - skills/<harvested-slug>/
  - openclaw.plugin.json
---

# skillpack-harvest — Editorial workflow for lifting host skills into gbrain

> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) for
> file placement rules. This skill writes into gbrain's own tree, not the
> brain repo's notes.

This skill is the inverse of `gbrain skillpack scaffold`. Scaffold ships
skills downstream (gbrain → host). Harvest lifts proven patterns
upstream (host → gbrain) so they become references every other client
can scaffold.

## Contract

A harvest is "properly done" when:

1. The host skill is mature (used in production, recent routing-eval
   cases pass).
2. The editorial genericization in Phase 3 has scrubbed every
   fork-specific reference (names, real entities, internal channels).
3. `gbrain skillpack harvest --dry-run` previewed the file set.
4. The real `gbrain skillpack harvest <slug> --from <host>` succeeded
   with `status: harvested` (no privacy-lint hits).
5. `bun test test/skills-conformance.test.ts` passes on the new
   `skills/<slug>/SKILL.md`.
6. The user has reviewed the diff in gbrain and explicitly approved
   the commit.

If any of these is incomplete, the skill is NOT yet harvested — the
files may sit in gbrain's working tree, but they're not landed.

## Output Format

This skill produces three artifacts in gbrain's working tree:

1. `skills/<harvested-slug>/SKILL.md` (and any sibling files like
   `routing-eval.jsonl`)
2. Paired source files at their mirror paths (e.g.
   `src/commands/<slug>.ts`) when the host SKILL.md declared them
   in frontmatter `sources:`
3. An updated `openclaw.plugin.json` with the new slug added to
   `skills:` (sorted)

The session output to the user is a one-line success summary plus
a list of files written. JSON mode (`--json`) returns the full
`HarvestResult` shape for machine consumption.

## Anti-Patterns

- **Skipping the dry-run.** Always preview first. Files land in
  gbrain's working tree; cleanup is a `git checkout` away, but you
  shouldn't need to.
- **Trusting the linter alone.** The default regex set catches the
  common cases. It doesn't catch every proper noun. Phase 3 (the
  editorial pass) is the primary defense.
- **Harvesting `--no-lint` without justification.** The lint exists
  for a reason. If you bypass it, document why in the commit.
- **Harvesting a skill that's still in flux.** Wait until the host
  version stabilizes. Otherwise you'll harvest, then re-harvest,
  then re-harvest, and that churns gbrain's bundle for no benefit.
- **Moving files instead of copying.** Harvest is a copy. The host
  retains its skill. Don't `rm -rf` the source after harvesting.
- **Harvesting batch (multiple skills at once).** Not supported, and
  for good reason — the editorial review per skill is real work.

## When to invoke

- The user developed a skill in their host fork (Wintermute, Neuromancer,
  Zion, etc.) and wants other gbrain clients to be able to use it
- A skill has proven itself in production and is ready to generalize
- The user explicitly asks to "harvest" or "publish" a skill upstream

Do NOT invoke when:
- The skill is still in flux locally — let it stabilize first
- The skill references private content that can't be generalized
- The user just wants to share a one-off draft (use a gist instead)

## Preconditions

Before running this skill, confirm:

1. **The skill is mature.** Recent `routing-eval.jsonl` cases pass; the
   skill has been used in production at least a few times.

2. **The skill is generalizable.** Strip-test in your head: replace
   every fork-specific name. Does it still make sense as a skill?

3. **The user owns the gbrain checkout.** The harvest writes into
   gbrain's working tree. They'll review and commit. Don't harvest
   into a checkout the user doesn't intend to commit from.

## Workflow

### Phase 1 — Plan

Ask the user:
- What slug should the harvested skill have? (Slugs must be kebab-case,
  globally unique in the gbrain bundle.)
- Which host repo is the source? (Path to repo root, not to the skill
  directory — e.g. `~/git/wintermute`, not `~/git/wintermute/skills/foo`.)
- Should paired source files come along? (Check the host SKILL.md's
  frontmatter `sources:` array.)

### Phase 2 — Dry-run + privacy-lint preview

Run the CLI with `--dry-run`:

```bash
gbrain skillpack harvest <slug> --from <host-repo-root> --dry-run
```

The output shows:
- Which files would land in gbrain's tree
- Whether paired sources are included
- (Implicit) The skill's frontmatter triggers — read them and check
  they generalize

Do **not** skip the dry-run. The privacy linter only runs on a real
harvest, but the dry-run preview lets you see the files before they
land. Spot-check the SKILL.md and any paired source for things the
linter might miss (proper nouns, internal project names, etc.).

### Phase 3 — Genericization checklist (the editorial pass)

Before running the real harvest, walk the host's `skills/<slug>/`
files and apply this checklist. If anything matches, edit the host
file FIRST, then run harvest.

1. **Fork-specific names → generic phrasing**
   - `Wintermute` → `your OpenClaw` (or `OpenClaw deployment`)
   - `Neuromancer`, `Zion`, `<personal-fork-name>` → same treatment
   - Personal first names (`garry`, `jane`, etc.) → `the user` /
     `you` / a generic placeholder

2. **Real entities → placeholders**
   - Real people, companies, deals, funds → placeholder slugs
     (`alice-example`, `acme-example`, `fund-a`, etc.)
   - Email addresses → strip entirely OR use `example@example.com`
   - Internal Slack channels → `#some-channel` or strip
   - Specific tracker IDs / Linear ticket numbers → strip

3. **Fork-specific conventions → references**
   - Mentions of `<host-repo>/docs/...` files → either lift the doc
     into gbrain OR replace with a generic placeholder explanation
   - Mentions of `<host-repo>/skills/<other-fork-only-skill>` → either
     decide to harvest that one too, or replace with a generic
     pattern reference

4. **Triggers array generalizes**
   - Read every entry in frontmatter `triggers:`. None should
     reference the user's name, fork name, or internal tools.
   - "Have garry sign off on it" → "have the user sign off on it"

5. **routing-eval.jsonl examples are scrubbed**
   - Open `skills/<slug>/routing-eval.jsonl`. Every `intent` field
     gets the same scrub as `triggers:`.

6. **Code comments + log strings**
   - If a paired source is going to be harvested, walk it for the
     same private-pattern leaks. Comments are the most common
     hiding spot.

### Phase 4 — Real harvest

Once Phase 3 is complete, run the real harvest:

```bash
gbrain skillpack harvest <slug> --from <host-repo-root>
```

Default behavior:
- Path-confinement + symlink rejection at file copy
- Privacy linter runs against `~/.gbrain/harvest-private-patterns.txt`
  (plus built-in defaults: `\bWintermute\b`, email, Slack channels)
- On any match → rollback (delete the harvested files) + exit non-zero
- `openclaw.plugin.json` updated to add the slug, sorted

Outcomes:
- `harvested` — success, manifest updated, files in gbrain's tree
- `lint_failed` — privacy linter caught something. Go back to Phase 3,
  scrub the host file, retry.
- `slug_collision` — gbrain already has a skill at that slug. Either
  use a different slug, or pass `--overwrite-local` if you really
  mean to replace.

### Phase 5 — Verify in gbrain

After a successful harvest:

1. `bun test test/skills-conformance.test.ts` — confirms the new
   SKILL.md meets the frontmatter contract.
2. `gbrain skillpack check --strict` — confirms no drift between
   bundle and gbrain's own checkout.
3. `gbrain skillpack list` — confirms the slug shows up in the bundle.
4. Review the diff: `cd <gbrainRoot> && git diff -- skills/<slug>/`
5. Commit the additions in gbrain (do NOT commit any leftover files
   in the host repo — harvest is a copy, not a move).

### Phase 6 — Downstream announcement (optional)

If other gbrain clients should pick up the new skill:
- Note it in `CHANGELOG.md` under "Skills added" for the next release
- Tag the user / contributor in the PR if the skill came from
  someone outside the core team

## Bypass: `--no-lint`

The privacy linter is the safety net. The editorial pass is the
primary defense. If you've completed Phase 3 thoroughly and the
linter is still firing on a false positive, use `--no-lint`:

```bash
gbrain skillpack harvest <slug> --from <host-repo-root> --no-lint
```

**Document the bypass in the commit message.** Future maintainers
should be able to see WHY the lint was bypassed (e.g. "Wintermute
appears in a citation, not a real reference — verified manually").

Never bypass the linter on a casual basis. The whole point of the
default-on lint is that real names occasionally slip through the
editorial pass.

## What harvest does NOT do

- It does NOT move files (it copies). The host's `skills/<slug>/`
  stays in place.
- It does NOT auto-scrub names. The editorial pass is human-driven.
- It does NOT publish to npm or a remote bundle. It writes to
  gbrain's working tree; the user commits + ships via the normal
  gbrain release process.
- It does NOT support `--all` (no batch harvest). One skill at a
  time keeps the editorial review tractable.

## Files this skill touches

- gbrain's `skills/<slug>/` — every file in the host skill dir
  (copy)
- gbrain's mirror path for declared paired sources
  (e.g. `src/commands/<slug>.ts` if the host SKILL.md declares it
  in frontmatter)
- gbrain's `openclaw.plugin.json` — adds the slug to `skills:`
  array, sorted alphabetically
