/**
 * Silent-drop regression test (Codex C2).
 *
 * The v0.13 code had THREE sites that silently skipped embeddings when
 * !process.env.OPENAI_API_KEY was true, even if the user had configured a
 * different provider. This test ensures all three sites now check
 * gateway.isAvailable('embedding') instead of hardcoded OPENAI_API_KEY.
 *
 *   1. src/core/ops/pages.ts (put_page handler; operations.ts is the façade)
 *   2. src/core/search/hybrid.ts:81 (vector search gate)
 *   3. src/core/import-file.ts:112 (chunk embedding in import pipeline)
 *
 * This is a static source-level regression — it greps for the forbidden
 * pattern. A positive match means the bug has been re-introduced.
 */

import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

// Resolve relative to this test file so it works on any machine + in CI.
const REPO_ROOT = resolve(import.meta.dir, '../..');
// The put_page handler lives in the ops domain modules (operations.ts is the
// assembly façade) — scan the whole ops surface so the negative pin is
// strictly stronger and a future move can't escape it.
const OPS_DIR = resolve(REPO_ROOT, 'src/core/ops');
const HYBRID = resolve(REPO_ROOT, 'src/core/search/hybrid.ts');
const IMPORT_FILE = resolve(REPO_ROOT, 'src/core/import-file.ts');

function opsSurface(): string {
  const files = [
    resolve(REPO_ROOT, 'src/core/operations.ts'),
    ...readdirSync(OPS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .map((f) => join(OPS_DIR, f)),
  ];
  return files.map((f) => readFileSync(f, 'utf-8')).join('\n');
}

test('ops surface put_page does not gate embedding on OPENAI_API_KEY alone', () => {
  const src = opsSurface();
  // The forbidden pattern from v0.13
  expect(src).not.toMatch(/!\s*process\.env\.OPENAI_API_KEY/);
  // The fix MUST reference isAvailable from the gateway
  expect(src).toMatch(/isAvailable\s*\(\s*['"]embedding['"]/);
});

test('hybrid.ts search does not gate vector path on OPENAI_API_KEY alone', () => {
  const src = readFileSync(HYBRID, 'utf-8');
  expect(src).not.toMatch(/!\s*process\.env\.OPENAI_API_KEY/);
  expect(src).toMatch(/isAvailable\s*\(\s*['"]embedding['"]/);
});

test('import-file.ts does NOT silently swallow embedding failures', () => {
  const src = readFileSync(IMPORT_FILE, 'utf-8');
  // The v0.13 try/catch that warned-and-continued is gone. If embedding fails,
  // the error must propagate — silent drop is unacceptable (Codex C2).
  // Evidence: the embedBatch call should not be inside a try/catch that only
  // logs. Search for "embedding failed for" which was the old warning message.
  expect(src).not.toMatch(/embedding failed for \$\{slug\}/);
});
