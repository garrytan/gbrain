/**
 * skillify/templates.ts — template strings for `gbrain skillify scaffold`.
 *
 * Pure-string generators. No I/O here; the caller writes files.
 */

/**
 * SKILLIFY_STUB sentinel (D-CX-9). Every scaffolded script body
 * carries this marker until an implementer replaces it. `gbrain
 * check-resolvable --strict` fails if the sentinel is present in any
 * committed skill script — it means a scaffold shipped without a
 * real implementation.
 */
export const SKILLIFY_STUB_MARKER = 'SKILLIFY_STUB: replace before running check-resolvable --strict';

export interface ScaffoldVars {
  /** Skill slug — must be lowercase-kebab-case. */
  name: string;
  /** One-line description for the frontmatter. */
  description: string;
  /** List of trigger phrases; empty → seed a TBD placeholder. */
  triggers: string[];
  /** Directories this skill will write brain pages to; optional. */
  writesTo: string[];
  /** Whether to mark the skill as `writes_pages: true`. */
  writesPages: boolean;
  /** Whether to mark the skill as `mutating: true`. */
  mutating: boolean;
}

export function skillMdTemplate(v: ScaffoldVars): string {
  const triggerLines =
    v.triggers.length > 0
      ? v.triggers.map(t => `  - "${t.replace(/"/g, '\\"')}"`).join('\n')
      : '  - "TBD-trigger — replace with phrases users actually type"';
  const writesToLines =
    v.writesTo.length > 0 ? v.writesTo.map(d => `  - ${d}`).join('\n') : '';

  const lines: string[] = [
    '---',
    `name: ${v.name}`,
    'version: 0.1.0',
    `description: ${v.description}`,
    'triggers:',
    triggerLines,
  ];
  if (v.mutating) lines.push('mutating: true');
  if (v.writesPages) {
    lines.push('writes_pages: true');
    if (writesToLines) {
      lines.push('writes_to:');
      lines.push(writesToLines);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(`# ${v.name}`);
  lines.push('');
  lines.push(`${v.description}`);
  lines.push('');
  lines.push('## The rule');
  lines.push('');
  lines.push(`<!-- ${SKILLIFY_STUB_MARKER} -->`);
  lines.push(
    'Replace this stub with the hard rule that prevents recurrence of the failure that triggered this skill.',
  );
  lines.push('');
  lines.push('## How to use');
  lines.push('');
  lines.push(
    `Run the deterministic script: \`bun scripts/${v.name}.mjs\` (or whatever your harness prefix is).`,
  );
  return lines.join('\n') + '\n';
}

export function scriptTemplate(v: ScaffoldVars): string {
  // The SKILLIFY_STUB_MARKER in a comment is what check-resolvable
  // --strict looks for. Remove the marker (not the whole file) when
  // the script is implemented.
  return `#!/usr/bin/env bun
// ${v.name} — scaffolded by gbrain skillify scaffold
// ${SKILLIFY_STUB_MARKER}
//
// Replace this stub with the deterministic logic the skill needs.
// Keep exports pure so tests can import them without side effects.

export function run(input: unknown): unknown {
  // TODO: implement. This stub is detected by \`gbrain check-resolvable
  // --strict\` and will fail CI until replaced.
  throw new Error('${v.name} scaffold not yet implemented');
}

if (import.meta.main) {
  const input = process.argv.slice(2).join(' ');
  console.log(JSON.stringify(run(input)));
}
`;
}

export function testTemplate(v: ScaffoldVars): string {
  return `/**
 * Tests for skills/${v.name}/scripts/${v.name}.mjs
 *
 * Scaffolded by gbrain skillify scaffold. Replace these stubs with
 * real cases — start with the regression case for the failure that
 * triggered this skill (essay Step 3).
 */

import { describe, expect, it } from 'bun:test';
import { run } from '../skills/${v.name}/scripts/${v.name}.mjs';

describe('${v.name}', () => {
  it('is scaffolded — replace this test with a real regression case', () => {
    expect(() => run(null)).toThrow();
  });
});
`;
}

/**
 * A single resolver table row for this skill. Uses the skill path
 * under `## Uncategorized`. The scaffolder handles the idempotency
 * contract (D-CX-7): never re-append a row that already exists.
 */
export function resolverRow(v: ScaffoldVars): string {
  const trigger =
    v.triggers.length > 0 ? v.triggers[0] : `TBD-trigger for ${v.name}`;
  return `| "${trigger.replace(/"/g, '\\"')}" | \`skills/${v.name}/SKILL.md\` |`;
}

export function routingEvalTemplate(v: ScaffoldVars): string {
  if (v.triggers.length === 0) {
    return (
      '// Routing eval fixtures for skills/' +
      v.name +
      '. Add paraphrased intents.\n' +
      '// Each line: {"intent": "...", "expected_skill": "' +
      v.name +
      '"}\n'
    );
  }
  const lines = ['// Routing eval fixtures for skills/' + v.name + '.'];
  for (const t of v.triggers.slice(0, 3)) {
    const paraphrase = `please ${t.toLowerCase()} for me now`;
    lines.push(
      JSON.stringify({ intent: paraphrase, expected_skill: v.name }),
    );
  }
  return lines.join('\n') + '\n';
}
