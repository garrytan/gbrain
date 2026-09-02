/**
 * The phantom redirect re-stamps the canonical's `content_hash` so the next
 * `gbrain sync` sees it as unchanged. It did that with a private copy of the
 * hash shape that had drifted from the canonical `contentHash` helper — it
 * never stripped HASH_EPHEMERAL_FRONTMATTER_KEYS. `captured_at` is stamped
 * per capture call, so for any canonical that arrived through `gbrain
 * capture` the stamped hash was one the importer could not reproduce, and
 * the next sync re-chunked + re-embedded the page — the exact opposite of
 * what the stamp is for. Same drift class #3694 consolidated.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { tryRedirectPhantom } from '../src/core/cycle/phantom-redirect.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { contentHash } from '../src/core/utils.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const FACT_FENCE = `# alice

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |
<!--- gbrain:facts:end -->
`;

function withTempDirs<T>(fn: (dirs: { brainDir: string }) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-hash-'));
  const brainDir = path.join(root, 'brain');
  const auditDir = path.join(root, 'audit');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  return withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
    try {
      return await fn({ brainDir });
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
}

/** The hash `gbrain sync` will compute for this file — import-file.ts's shape. */
function importerHashOf(filePath: string): string {
  const parsed = parseMarkdown(fs.readFileSync(filePath, 'utf-8'), path.basename(filePath));
  parsed.tags.sort();
  return contentHash({
    title: parsed.title,
    type: parsed.type,
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline,
    frontmatter: parsed.frontmatter,
    tags: parsed.tags,
  });
}

async function redirectOnto(
  brainDir: string,
  canonicalFrontmatter: Record<string, unknown>,
): Promise<{ stamped: string | undefined; expected: string }> {
  const canonical = 'people/alice-example';
  const canonicalPath = path.join(brainDir, `${canonical}.md`);

  await engine.putPage(canonical, {
    title: 'alice-example',
    type: 'person' as never,
    compiled_truth: '# alice-example\n',
    frontmatter: canonicalFrontmatter,
    timeline: '',
  });
  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
  const fm = Object.entries(canonicalFrontmatter)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join('\n');
  fs.writeFileSync(
    canonicalPath,
    `---\ntype: person\ntitle: alice-example\n${fm}${fm ? '\n' : ''}---\n\n# alice-example\n`,
    'utf-8',
  );

  await engine.putPage('alice', {
    title: 'alice',
    type: 'person' as never,
    compiled_truth: FACT_FENCE,
    frontmatter: {},
    timeline: '',
  });
  fs.writeFileSync(path.join(brainDir, 'alice.md'), FACT_FENCE, 'utf-8');

  const phantom = await engine.getPage('alice', { sourceId: 'default' });
  const result = await tryRedirectPhantom(engine, phantom!, 'default', brainDir, false);
  expect(result.outcome).toBe('redirected');

  const after = await engine.getPage(canonical, { sourceId: 'default' });
  return { stamped: after?.content_hash, expected: importerHashOf(canonicalPath) };
}

describe('phantom redirect content_hash parity with the importer', () => {
  test('a canonical carrying an ephemeral frontmatter key is stamped with the importer hash', async () => {
    await withTempDirs(async ({ brainDir }) => {
      // captured_at is in HASH_EPHEMERAL_FRONTMATTER_KEYS; a second key is
      // present so the page is not the accidentally-converging 0/1-key case.
      const { stamped, expected } = await redirectOnto(brainDir, {
        captured_at: '2026-01-02T03:04:05.000Z',
        origin: 'unit-test',
      });
      expect(stamped).toBeTruthy();
      expect(stamped).toBe(expected);
    });
  });

  test('control: a canonical with no ephemeral key was already correct', async () => {
    await withTempDirs(async ({ brainDir }) => {
      const { stamped, expected } = await redirectOnto(brainDir, { origin: 'unit-test' });
      expect(stamped).toBeTruthy();
      expect(stamped).toBe(expected);
    });
  });
});
