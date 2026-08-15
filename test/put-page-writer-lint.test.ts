/**
 * put_page writer_lint payload tests (T11 writer-lint visibility).
 *
 * Pins the extended writer_lint response contract, previously unpinned:
 *   - lint ran, zero findings → full summary present with zeroed fields
 *   - lint ran, findings past the cap → errors-first top_findings (cap 5),
 *     details_truncated, by_validator histogram, one actionable hint each
 *   - lint crashed → {status: 'lint_error'} (distinguishable from lint-off)
 *   - flag off / validate:false frontmatter → writer_lint key absent
 *   - FIX_HINTS completeness against the BUILTIN_VALIDATORS registry
 *
 * The crash path is pinned at the writerLintForPutPage seam (a stub engine
 * whose getPage rejects): put_page spreads whatever the seam returns, and
 * crashing the real handler mid-flow would need a module-level mock
 * (serial-file quarantine) for no extra coverage.
 *
 * PGLite hermetic; resetGateway() keeps embedding auto-detect keyless.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext, Operation } from '../src/core/operations.ts';
import {
  summarizeWriterLint,
  writerLintForPutPage,
  type WriterLintSummary,
} from '../src/core/output/post-write.ts';
import { BUILTIN_VALIDATORS, FIX_HINTS } from '../src/core/output/validators/index.ts';
import type { ValidationFinding } from '../src/core/output/writer.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

const put_page = operations.find(o => o.name === 'put_page') as Operation;
if (!put_page) throw new Error('put_page op missing');

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

function page(body: string, frontmatterLines: string[] = []): string {
  return ['---', 'type: concept', 'title: Notes', ...frontmatterLines, '---', '', body].join('\n');
}

/** No citation markers, all factual per looksFactual — one citation error each. */
const SIX_UNCITED_PARAGRAPHS = [
  'Acme raised a $5M seed round from fund-a in early 2024.',
  'The founder previously built a payments product at widget-co.',
  'Acme shipped its first public beta to customers in March 2025.',
  'The team has twelve engineers and two designers on staff today.',
  'Acme was founded in a garage in Mountain View by two brothers.',
  'The company will launch its enterprise tier early next quarter.',
].join('\n\n');

function finding(over: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    slug: 'people/x',
    validator: 'citation',
    severity: 'error',
    line: 3,
    message: 'Paragraph has no citation marker',
    ...over,
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  resetGateway();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  // Keyless embedding auto-detect: another file in this shard process may
  // have configured the module-global gateway; put_page reads it for noEmbed.
  resetGateway();
});

describe('FIX_HINTS registry completeness (ENG-12)', () => {
  test('every BUILTIN_VALIDATORS id has a non-empty hint', () => {
    expect(BUILTIN_VALIDATORS.length).toBeGreaterThanOrEqual(4);
    for (const v of BUILTIN_VALIDATORS) {
      const hint = FIX_HINTS[v.id];
      expect(typeof hint).toBe('string');
      expect((hint ?? '').length).toBeGreaterThan(0);
    }
  });

  test('registry covers the four known validators', () => {
    const ids = BUILTIN_VALIDATORS.map(v => v.id).sort();
    expect(ids).toEqual(['back-link', 'citation', 'link', 'triple-hr']);
  });

  test('FIX_HINTS carries no orphan keys (hints derive from the registry)', () => {
    const ids = new Set(BUILTIN_VALIDATORS.map(v => v.id));
    for (const key of Object.keys(FIX_HINTS)) {
      expect(ids.has(key)).toBe(true);
    }
  });
});

describe('summarizeWriterLint', () => {
  test('zero findings → zeroed summary with empty structures', () => {
    expect(summarizeWriterLint([])).toEqual({
      error_count: 0,
      warning_count: 0,
      top_findings: [],
      details_truncated: false,
      by_validator: {},
    });
  });

  test('errors sort before warnings; order within a severity is stable', () => {
    const s = summarizeWriterLint([
      finding({ validator: 'back-link', severity: 'warning', message: 'w1' }),
      finding({ validator: 'citation', severity: 'error', message: 'e1' }),
      finding({ validator: 'triple-hr', severity: 'warning', message: 'w2' }),
      finding({ validator: 'link', severity: 'error', message: 'e2' }),
    ]);
    expect(s.top_findings.map(f => f.message)).toEqual(['e1', 'e2', 'w1', 'w2']);
  });

  test('caps top_findings at 5 and flags details_truncated', () => {
    const findings = Array.from({ length: 7 }, (_, i) => finding({ message: `e${i}` }));
    const s = summarizeWriterLint(findings);
    expect(s.top_findings).toHaveLength(5);
    expect(s.details_truncated).toBe(true);
    expect(s.error_count).toBe(7);
  });

  test('exactly 5 findings is not truncated', () => {
    const findings = Array.from({ length: 5 }, (_, i) => finding({ message: `e${i}` }));
    const s = summarizeWriterLint(findings);
    expect(s.top_findings).toHaveLength(5);
    expect(s.details_truncated).toBe(false);
  });

  test('by_validator counts EVERY finding, not just the top 5', () => {
    const findings = [
      ...Array.from({ length: 6 }, () => finding({ validator: 'citation' })),
      finding({ validator: 'link', severity: 'warning' }),
    ];
    expect(summarizeWriterLint(findings).by_validator).toEqual({ citation: 6, link: 1 });
  });

  test('long messages are truncated to the cap with an ellipsis tail', () => {
    const s = summarizeWriterLint([finding({ message: 'x'.repeat(300) })]);
    expect(s.top_findings[0].message).toHaveLength(200);
    expect(s.top_findings[0].message.endsWith('...')).toBe(true);
  });

  test('line rides through when present and is omitted when absent', () => {
    const s = summarizeWriterLint([
      finding({ line: 12 }),
      finding({ line: undefined }),
    ]);
    expect(s.top_findings[0].line).toBe(12);
    expect('line' in s.top_findings[1]).toBe(false);
  });

  test('hints come from FIX_HINTS; unknown validators get the fallback', () => {
    const s = summarizeWriterLint([
      finding({ validator: 'citation' }),
      finding({ validator: 'not-a-builtin' }),
    ]);
    expect(s.top_findings[0].hint).toBe(FIX_HINTS['citation']);
    expect(s.top_findings[1].hint.length).toBeGreaterThan(0);
  });
});

describe('writerLintForPutPage outcome mapping', () => {
  test('lint machinery throwing → {status: lint_error}, never a throw', async () => {
    const broken = {
      getPage: async () => { throw new Error('db exploded mid-lint'); },
    } as unknown as BrainEngine;
    // force:true skips the config read, so getPage is the first engine touch.
    const payload = await writerLintForPutPage(broken, 'people/x', { force: true });
    expect(payload).toEqual({ status: 'lint_error' });
  });

  test('lint off (flag unset) → undefined, so the key stays absent', async () => {
    const off = {
      getConfig: async () => null,
    } as unknown as BrainEngine;
    expect(await writerLintForPutPage(off, 'people/x')).toBeUndefined();
  });
});

describe('put_page writer_lint payload (PGLite e2e)', () => {
  test('lint ran with zero findings → summary present, all zeroed', async () => {
    await engine.setConfig('writer.lint_on_put_page', 'true');
    const r = await put_page.handler(makeCtx(), {
      slug: 'notes/clean',
      content: page('## See Also\n- [Source: X/clean, 2026-04-18](https://x.com/clean/status/1)'),
    }) as { writer_lint?: WriterLintSummary };
    expect(r.writer_lint).toEqual({
      error_count: 0,
      warning_count: 0,
      top_findings: [],
      details_truncated: false,
      by_validator: {},
    });
  });

  test('findings past the cap → errors-first top 5, truncation flag, histogram, hints', async () => {
    await engine.setConfig('writer.lint_on_put_page', 'true');
    // 6 uncited factual paragraphs (citation errors) + 1 mailto bullet (link
    // warning). The local lint log writes under GBRAIN_HOME — point it at tmp.
    const home = mkdtempSync(join(tmpdir(), 'gbrain-lint-home-'));
    const r = await withEnv({ GBRAIN_HOME: home }, async () =>
      await put_page.handler(makeCtx(), {
        slug: 'notes/dirty',
        content: page(`${SIX_UNCITED_PARAGRAPHS}\n\n- [contact](mailto:someone@example.com)`),
      }) as { writer_lint?: WriterLintSummary },
    );

    const lint = r.writer_lint!;
    expect(lint.error_count).toBe(6);
    expect(lint.warning_count).toBe(1);
    expect(lint.details_truncated).toBe(true);
    expect(lint.by_validator).toEqual({ citation: 6, link: 1 });

    expect(lint.top_findings).toHaveLength(5);
    for (const f of lint.top_findings) {
      // Errors-first at cap 5 with 6 errors present → all five are errors.
      expect(f.severity).toBe('error');
      expect(f.validator).toBe('citation');
      expect(typeof f.line).toBe('number');
      expect(f.message).toContain('no citation marker');
      expect(f.hint).toBe(FIX_HINTS['citation']);
    }
  });

  test('flag off → writer_lint key absent (lint-off, not a crash)', async () => {
    const r = await put_page.handler(makeCtx(), {
      slug: 'notes/flag-off',
      content: page(SIX_UNCITED_PARAGRAPHS),
    }) as Record<string, unknown>;
    expect('writer_lint' in r).toBe(false);
  });

  test('validate:false frontmatter → key absent even with the flag on', async () => {
    await engine.setConfig('writer.lint_on_put_page', 'true');
    const r = await put_page.handler(makeCtx(), {
      slug: 'notes/grandfathered',
      content: page(SIX_UNCITED_PARAGRAPHS, ['validate: false']),
    }) as Record<string, unknown>;
    expect('writer_lint' in r).toBe(false);
  });
});
