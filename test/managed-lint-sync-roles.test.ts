// Managed lint scans the same roles managed sync imports: scaffolding and reserved skill bundles are not lint targets.
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runLintCore } from '../src/commands/lint.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const NOTE = '---\ntitle: Typed\ntype: note\ndate: 2026-01-01\n---\n\nBody.\n';
const FILES: Record<string, string> = {
  'README.md': 'Plain directory guide.\n',
  'notes/bare/README.md': 'Plain directory guide.\n',
  'skills/example/SKILL.md': '---\nname: example\ndescription: A skill.\n---\n\nSteps.\n',
  'notes/typed/README.md': NOTE,
  'notes/empty.md': `${NOTE}\n## Empty\n`,
};

test('managed lint skips sync scaffolding and skill bundles, keeps typed pages', async () => {
  let scanned: string[] = [];
  let single = 0;
  await managedBrain(async ({ engine, root }) => {
    for (const [rel, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const result = await runLintCore({ target: root, engine, sourceId: 'default', fix: false, dryRun: true, onPagesCollected: n => { scanned.push(String(n)); } });
    scanned = [String(result.pages_scanned), String(result.total_issues)];
    single = (await runLintCore({ target: join(root, 'README.md'), engine, sourceId: 'default', fix: false, dryRun: true })).total_issues;
  });
  // typed nested README (clean) + empty.md (one empty-section finding)
  expect(scanned).toEqual(['2', '1']);
  // an explicit file target is still linted
  expect(single).toBeGreaterThan(0);
}, 60_000);
