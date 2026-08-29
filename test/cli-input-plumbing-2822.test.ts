/**
 * #2822 — input-plumbing honesty for put-shaped commands.
 *
 * Three failure modes conspired to silently destroy or no-op page content:
 *   1. Empty/whitespace non-TTY stdin landed '' in the stdin param
 *      (covered in test/cli-stdin-hang.test.ts — param now stays unset).
 *   2. A flag silently overwriting an already-set positional (e.g.
 *      `gbrain put notes.md --slug real-slug`) discarded a value with no
 *      trace; when the discarded value names an existing file the user
 *      almost certainly wanted `gbrain capture --file`.
 *   3. A "successful" put with 0 chunks left the page unsearchable with no
 *      explanation — the response now carries chunk_skip_reason.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseOpArgs } from '../src/cli.ts';
import { operations, operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

// PGLite schema init (130 migrations) exceeds the 5s default hook timeout on
// a loaded machine — same mitigation as hybrid-cache-scope-poison.serial.
setDefaultTimeout(30_000);

// ── Part 2: flag-overwrites-positional warning ────────────────────────────

function captureStderr(fn: () => void): string {
  const orig = process.stderr.write.bind(process.stderr);
  let out = '';
  (process.stderr as { write: (c: unknown) => boolean }).write = (c: unknown) => {
    out += String(c);
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr as { write: typeof orig }).write = orig;
  }
  return out;
}

describe('#2822 — parseOpArgs warns when a flag overwrites a set positional', () => {
  const putOp = operationsByName.put_page ?? operations.find((o) => o.name === 'put_page')!;

  test('warns on --slug overwriting the positional slug', () => {
    let params: Record<string, unknown> = {};
    const err = captureStderr(() => {
      params = parseOpArgs(putOp, ['stray-value', '--slug', 'real-slug']);
    });
    expect(params.slug).toBe('real-slug'); // flag still wins (behavior unchanged)
    expect(err).toContain('overwrites the positional value');
    expect(err).toContain('stray-value');
  });

  test('suggests capture --file when the discarded positional names an existing file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-2822-'));
    const file = path.join(tmp, 'notes.md');
    fs.writeFileSync(file, '# notes\n');
    try {
      const err = captureStderr(() => {
        parseOpArgs(putOp, [file, '--slug', 'real-slug']);
      });
      expect(err).toContain('gbrain capture --file');
      expect(err).toContain(file);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('no warning when nothing is overwritten', () => {
    const err = captureStderr(() => {
      parseOpArgs(putOp, ['my-slug', '--content', 'hello world']);
    });
    expect(err).toBe('');
  });

  test('no warning when the flag repeats the same value', () => {
    const err = captureStderr(() => {
      parseOpArgs(putOp, ['same-slug', '--slug', 'same-slug']);
    });
    expect(err).toBe('');
  });
});

// ── Part 3: chunk_skip_reason on 0-chunk puts ─────────────────────────────

let engine: PGLiteEngine;

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
  resetGateway(); // no embedding provider → put_page runs noEmbed
});

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

const putPage = operations.find((o) => o.name === 'put_page')!;

describe('#2822 — chunk_skip_reason on 0-chunk puts', () => {
  test('frontmatter-only content on a new slug → empty_body', async () => {
    const result = (await putPage.handler(makeCtx(), {
      slug: 'inbox/frontmatter-only',
      content: '---\ntitle: Nothing else\n---\n',
    })) as { status: string; chunks: number; chunk_skip_reason?: string };
    expect(result.chunks).toBe(0);
    expect(result.chunk_skip_reason).toBe('empty_body');
  });

  test('embed_skip-marked content (trusted local) → embed_skip', async () => {
    const result = (await putPage.handler(makeCtx(), {
      slug: 'inbox/skipped-embed',
      content: '---\ntitle: Big\nembed_skip: true\n---\n\nSome body text that will not be chunked.',
    })) as { chunks: number; chunk_skip_reason?: string };
    expect(result.chunks).toBe(0);
    expect(result.chunk_skip_reason).toBe('embed_skip');
  });

  test('normal content chunks → no chunk_skip_reason', async () => {
    const result = (await putPage.handler(makeCtx(), {
      slug: 'inbox/normal',
      content: '---\ntitle: Normal\n---\n\nA real body with searchable content.',
    })) as { chunks: number; chunk_skip_reason?: string };
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.chunk_skip_reason).toBeUndefined();
  });

  test('unchanged rewrite (skipped) → write_skipped', async () => {
    const content = '---\ntitle: Stable\n---\n\nSame content twice.';
    await putPage.handler(makeCtx(), { slug: 'inbox/stable', content });
    const second = (await putPage.handler(makeCtx(), { slug: 'inbox/stable', content })) as {
      status: string; chunks: number; chunk_skip_reason?: string;
    };
    expect(second.status).toBe('skipped');
    expect(second.chunk_skip_reason).toBe('write_skipped');
  });
});
