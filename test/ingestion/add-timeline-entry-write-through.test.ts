/**
 * add_timeline_entry markdown write-through (Minerva fork).
 *
 * Verifies the op inserts timeline_entries AND appends the matching
 * bullet into pages.timeline + brain-repo .md (same sink as put_page).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { operations } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { resetGateway } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-tl-wt-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const captureLogger = () => {
  const messages: Array<{ level: string; msg: string }> = [];
  return {
    logger: {
      info: (msg: string) => messages.push({ level: 'info', msg }),
      warn: (msg: string) => messages.push({ level: 'warn', msg }),
      error: (msg: string) => messages.push({ level: 'error', msg }),
    },
    messages,
  };
};

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  const { logger } = captureLogger();
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

const putPage = operations.find((o) => o.name === 'put_page')!;
const addTimeline = operations.find((o) => o.name === 'add_timeline_entry')!;

async function seedPage(slug: string, compiled: string, timeline = '## Timeline\n'): Promise<void> {
  const content = `---\ntitle: Seed\n---\n\n${compiled}\n\n<!-- timeline -->\n\n${timeline}`;
  await putPage.handler(makeCtx(), { slug, content });
}

describe('add_timeline_entry write-through — happy path', () => {
  test('appends bullet to pages.timeline and disk .md', async () => {
    const slug = 'inbox/tl-wt-happy';
    await seedPage(slug, '# Body');

    const result = (await addTimeline.handler(makeCtx(), {
      slug,
      date: '2026-07-22',
      summary: 'Write-through smoke',
      source: 'test',
      detail: 'Line two',
    })) as {
      status: string;
      markdown?: { written: boolean; path?: string; skipped?: string; error?: string };
    };

    expect(result.status).toBe('ok');
    expect(result.markdown?.written).toBe(true);
    expect(result.markdown?.path).toBe(path.join(brainDir, `${slug}.md`));

    const page = await engine.getPage(slug);
    expect(page?.timeline).toContain('- **2026-07-22** | Write-through smoke [Source: test]');
    expect(page?.timeline).toContain('Line two');

    const onDisk = fs.readFileSync(result.markdown!.path!, 'utf8');
    expect(onDisk).toContain('- **2026-07-22** | Write-through smoke [Source: test]');
    expect(onDisk).toContain('Line two');
  });

  test('idempotent when the same bullet already exists', async () => {
    const slug = 'inbox/tl-wt-idem';
    await seedPage(
      slug,
      '# Body',
      '## Timeline\n\n- **2026-07-22** | Already here [Source: test]\n',
    );

    const result = (await addTimeline.handler(makeCtx(), {
      slug,
      date: '2026-07-22',
      summary: 'Already here',
      source: 'test',
    })) as { markdown?: { written: boolean; skipped?: string } };

    // Ledger insert still runs; markdown path skips duplicate bullet.
    expect(result.markdown?.written).toBe(false);
    expect(result.markdown?.skipped).toBe('already_present');
  });
});

describe('add_timeline_entry write-through — trust gating', () => {
  test('subagent sandbox skips markdown write-through', async () => {
    const slug = 'inbox/tl-wt-sandbox';
    await seedPage(slug, '# Body');

    const result = (await addTimeline.handler(
      makeCtx({ viaSubagent: true }),
      {
        slug,
        date: '2026-07-22',
        summary: 'Sandbox entry',
      },
    )) as { markdown?: { written: boolean; skipped?: string } };

    expect(result.markdown?.written).toBe(false);
    expect(result.markdown?.skipped).toBe('subagent_sandbox');

    const page = await engine.getPage(slug);
    expect(page?.timeline ?? '').not.toContain('Sandbox entry');
  });
});
