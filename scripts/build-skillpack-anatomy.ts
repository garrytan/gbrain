#!/usr/bin/env bun
/**
 * Regenerate docs/skillpack-anatomy.md from the declarative rubric.
 *
 * The doc has a hand-written Cortex SaaS frame plus an auto-generated rubric
 * table. This script updates only the table when the markers already exist.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
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
    '### Core dimensions',
    '',
    '| # | Name | Description | Auto-fixable |',
    '|---|------|-------------|--------------|',
    rows(core),
    '',
    '### Quality badges',
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

const HAND_WRITTEN_FRAME = `# Skillpack Anatomy

Cortex skillpacks are curated runtime capability bundles for hosted company
brains. Public skillpacks must be tenant-safe, Cortex-branded, and suitable for
agents connected through scoped MCP OAuth clients.

## Tree

\`\`\`text
my-skillpack/
  skillpack.json
  skills/
    <skill-slug>/
      SKILL.md
      routing-eval.jsonl
  runbooks/
    bootstrap.md
  test/
  e2e/
  evals/
  CHANGELOG.md
  LICENSE
  README.md
\`\`\`

\`cortex skillpack init <name>\` scaffolds this tree. Replace the stubs with
real tenant-safe content, run \`cortex skillpack doctor\` between edits, and
\`cortex skillpack pack\` produces a deterministic package ready for review.

## Agent Use

After \`cortex skillpack scaffold <source>\` lands the files:

1. The agent walks \`skills/*/SKILL.md\` frontmatter and reads each pack's
   \`triggers:\` array on startup or per-message.
2. When user phrasing matches a trigger, the agent reads that \`SKILL.md\` body
   as in-context instructions.
3. Cortex displays \`runbooks/bootstrap.md\` once after scaffold but does not
   auto-execute it. Tenant mutation stays explicit.

## Doctor Scoring

Ten binary dimensions are checked by pure functions in
\`src/core/skillpack/rubric.ts\`. The doctor prints the score, status, and
paste-ready fix for every failure.

`;

const HAND_WRITTEN_FOOTER = `
## Tier Eligibility

| Tier | Requirement |
|------|-------------|
| \`endorsed\` | All 5 core + all 5 badges, plus Cortex registry approval |
| \`community\` | All 5 core + at least 3 of 5 badges |
| \`experimental\` | All 5 core + fewer than 3 badges |
| \`blocked\` | Any core dimension fails |

## CLI Reference

\`\`\`bash
cortex skillpack init my-pack
cortex skillpack doctor my-pack
cortex skillpack doctor my-pack --fix --yes
cortex skillpack pack my-pack
cortex skillpack search <query>
cortex skillpack info <name>
cortex skillpack scaffold <source>
cortex skillpack registry --url <registry-url>
\`\`\`

The hosted Cortex runtime package currently ships only the active SaaS runtime
skills listed in \`skills/manifest.json\`.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');

  const generatedSection = buildRubricSection();
  const existing = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, 'utf-8') : '';

  let next: string;
  if (existing.includes(BEGIN) && existing.includes(END)) {
    const before = existing.slice(0, existing.indexOf(BEGIN));
    const after = existing.slice(existing.indexOf(END) + END.length);
    next = before + generatedSection + after;
  } else {
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
