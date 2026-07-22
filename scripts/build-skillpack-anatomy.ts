#!/usr/bin/env bun
/**
 * scripts/build-skillpack-anatomy.ts — regenerate docs/skillpack-anatomy.md
 * from the declarative rubric.ts. The doc has a hand-written intro + tree
 * diagram and an auto-generated rubric table; this script regenerates the
 * table only, between explicit BEGIN/END markers.
 *
 * Run: `bun run scripts/build-skillpack-anatomy.ts`
 * CI:  `scripts/check-anatomy-fresh.sh` runs this in --check mode and
 *       fails the build if the committed doc differs from regenerated.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

import { describeRubric } from '../src/core/skillpack/rubric.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const DOC_PATH = join(REPO_ROOT, 'docs', 'skillpack-anatomy.md');

const BEGIN = '<!-- BEGIN auto-generated:rubric -->';
const END = '<!-- END auto-generated:rubric -->';

function buildRubricSection(): string {
  const rubric = describeRubric();
  const core = rubric.filter((d) => d.category === 'core');
  const badges = rubric.filter((d) => d.category === 'badge');

  const rows = (list: typeof rubric) =>
    list
      .map(
        (d) =>
          `| ${d.id} | \`${d.name}\` | ${d.description} | ${d.auto_fixable ? 'yes' : 'no'} |`,
      )
      .join('\n');

  return [
    BEGIN,
    '',
    '### Core dimensions (5; must all pass to publish at any tier)',
    '',
    '| # | Name | Description | Auto-fixable |',
    '|---|------|-------------|--------------|',
    rows(core),
    '',
    '### Quality badges (5; earn for tier eligibility)',
    '',
    '| # | Name | Description | Auto-fixable |',
    '|---|------|-------------|--------------|',
    rows(badges),
    '',
    '_Generated from `src/core/skillpack/rubric.ts` by `bun run scripts/build-skillpack-anatomy.ts`._',
    '',
    END,
  ].join('\n');
}

const HAND_WRITTEN_FRAME = `# Skillpack anatomy

The canonical one-page reference for what a third-party gbrain skillpack
looks like. The reference pack at \`examples/skillpack-reference/\` is the
live artifact this page describes; clone its tree and you have a 10/10
starting point.

## Tree

\`\`\`
my-skillpack/
├── skillpack.json                # manifest (cathedral fields declared)
├── skills/
│   └── <skill-slug>/
│       ├── SKILL.md              # frontmatter + body, agent-readable
│       └── routing-eval.jsonl    # >= 5 intents pinning trigger -> skill
├── runbooks/
│   └── bootstrap.md              # post-scaffold display (NOT an executor)
├── test/
│   └── *.test.ts                 # bun:test unit tests
├── e2e/
│   └── *.test.ts                 # integration tests, gated on DATABASE_URL
├── evals/
│   └── *.judge.json              # LLM-judge eval configs (>= 3 cases each)
├── CHANGELOG.md                  # Keep-a-Changelog shape
├── LICENSE                       # SPDX-matching text
├── README.md
└── .gitignore
\`\`\`

\`gbrain skillpack init <name>\` scaffolds this exact tree, pre-filled
with stubs that score 10/10 on \`gbrain skillpack doctor . --quick\`
immediately. Replace the stubs with real content, run the doctor
between edits, and \`gbrain skillpack pack\` produces a deterministic
\`<name>-<version>.tgz\` ready to publish to the registry.

## How the agent uses a scaffolded pack

After \`gbrain skillpack scaffold <source>\` lands the files:

1. The user's agent walks \`skills/*/SKILL.md\` frontmatter and reads
   each pack's \`triggers:\` array on startup or per-message.
2. When a user phrasing matches a trigger, the agent reads that
   SKILL.md body top-to-bottom as in-context instructions.
3. gbrain DISPLAYS \`runbooks/bootstrap.md\` once after the scaffold
   but does NOT auto-execute it. The agent decides whether to walk
   the steps. This is the codex T1 supply-chain hardening: an
   auto-walker would let a malicious pack mutate the user's brain
   on install, which is how npm postinstall attacks happen.

## How the doctor scores a pack

Ten binary dimensions. Each is checked by a pure function in
\`src/core/skillpack/rubric.ts\` and returns \`{passed, detail, fix_hint}\`.
The doctor walks them in order and prints the score + per-dimension
status + paste-ready fix for every failure.

`;

const HAND_WRITTEN_FOOTER = `
## Tier eligibility

| Tier | Requirement |
|------|-------------|
| \`endorsed\` | All 5 core + all 5 badges, plus Garry's \`endorsements.json\` overlay in the registry repo |
| \`community\` | All 5 core + >= 3 of 5 badges. Default tier on PR merge. |
| \`experimental\` | All 5 core + < 3 badges |
| \`blocked\` | Any core dimension fails |

## CLI reference (third-party path)

\`\`\`bash
# Publisher side
gbrain skillpack init my-pack         # scaffold the tree
gbrain skillpack doctor my-pack       # see the score + fix hints
gbrain skillpack doctor my-pack --fix --yes  # auto-scaffold missing pieces
gbrain skillpack pack my-pack         # deterministic tarball + SHA-256

# Consumer side
gbrain skillpack search <query>       # browse the registry
gbrain skillpack info <name>          # show full pack metadata
gbrain skillpack scaffold <source>    # owner/repo, https, ./dir, ./*.tgz
gbrain skillpack registry --url X     # point at a custom registry
\`\`\`

## See also

- \`examples/skillpack-reference/\` — the live 10/10 reference pack
- \`docs/designs/SKILLPACK_REGISTRY_V1_SPEC.md\` — strategic spec + decisions
- \`docs/guides/skillpacks-as-scaffolding.md\` — v0.36 scaffold/reference model
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');

  const generatedSection = buildRubricSection();

  let existing = '';
  if (existsSync(DOC_PATH)) {
    existing = readFileSync(DOC_PATH, 'utf-8');
  }

  let next: string;
  if (existing.includes(BEGIN) && existing.includes(END)) {
    // Replace the existing auto-section in place.
    const before = existing.slice(0, existing.indexOf(BEGIN));
    const after = existing.slice(existing.indexOf(END) + END.length);
    next = before + generatedSection + after;
  } else {
    // First-time write: emit hand-written frame + auto section + footer.
    next = HAND_WRITTEN_FRAME + generatedSection + HAND_WRITTEN_FOOTER;
  }

  if (checkMode) {
    if (existing.trim() !== next.trim()) {
      process.stderr.write(
        '[check-anatomy-fresh] docs/skillpack-anatomy.md is out of sync with rubric.ts. Run `bun run scripts/build-skillpack-anatomy.ts` to regenerate.\n',
      );
      process.exit(1);
    }
    process.stderr.write('[check-anatomy-fresh] docs/skillpack-anatomy.md is fresh.\n');
    process.exit(0);
  }

  writeFileSync(DOC_PATH, next);
  process.stderr.write(`[skillpack-anatomy] wrote ${DOC_PATH}\n`);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exit(2);
  });
}
