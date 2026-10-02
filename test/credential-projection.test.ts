/**
 * Credential-safe retrieval projection (security wave ENG-1 / CEO-19).
 *
 * Protects: no fragment of a stored private key reaches chunks (and so the
 * embedding provider) or any retrieval op output, including chunks that
 * contain neither key fence, and evidence delivered in window/section/page
 * units is cut from the same projected text so anchors still locate.
 * Regression it catches: a chunker or evidence path that slices the raw body
 * before the private-key pass (master split a 4096-bit key into chunks whose
 * middle part carried 42 body lines and no fence, and the output redactor
 * could not recognise them). Existing coverage scans only finished output,
 * per chunk. No seams: real chunkers, real ops on PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { credentialSafeProjection, PRIVATE_KEY_PROJECTION_TOKEN } from '../src/core/credential-projection.ts';
import { chunkText } from '../src/core/chunkers/recursive.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';
import { prepareCodeChunks } from '../src/core/code-chunks.ts';
import { pageEvidenceText } from '../src/core/search/evidence-delivery.ts';
import type { SearchResult } from '../src/core/types.ts';

function ephemeralKey(bits = 4096): string {
  return generateKeyPairSync('rsa', {
    modulusLength: bits,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

const KEY = ephemeralKey();
const KEY_LINES = KEY.split('\n').filter(line => /^[A-Za-z0-9+/=]{16,}$/.test(line));

/** 24-char windows of every body line: any one of them in output is a leaked fragment. */
const FRAGMENTS = KEY_LINES.flatMap(line => {
  const out: string[] = [];
  for (let i = 0; i + 24 <= line.length; i += 8) out.push(line.slice(i, i + 24));
  return out;
});

function leakedFragments(payload: unknown): string[] {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return FRAGMENTS.filter(fragment => text.includes(fragment));
}

const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i} word`).join(' ');

/** Prose around the key so the default chunker splits through the key body. */
const PAGE_BODY = `## Deploy notes\n\n${words(140, 'alpha')}\n\nThe deploy service key:\n\n${KEY}\n## Rotation\n\n${words(140, 'omega')}\n`;

describe('credentialSafeProjection', () => {
  test('replaces the key with one token, keeps every line offset, and is idempotent', () => {
    const projected = credentialSafeProjection(PAGE_BODY);
    expect(leakedFragments(projected)).toEqual([]);
    expect(projected).toContain(PRIVATE_KEY_PROJECTION_TOKEN);
    expect(projected.includes('PRIVATE KEY-----')).toBe(false);
    expect(projected.split('\n').length).toBe(PAGE_BODY.split('\n').length);
    const original = PAGE_BODY.split('\n');
    const after = projected.split('\n');
    const rotationLine = original.indexOf('## Rotation');
    expect(after[rotationLine]).toBe('## Rotation');
    expect(credentialSafeProjection(projected)).toBe(projected);
  });

  test('a key cut off before its END fence is still replaced', () => {
    const truncated = `Notes before.\n${KEY.split('\n').slice(0, 12).join('\n')}`;
    const projected = credentialSafeProjection(truncated);
    expect(leakedFragments(projected)).toEqual([]);
    expect(projected.split('\n').length).toBe(truncated.split('\n').length);
  });

  test('text without a key marker is returned unchanged', () => {
    const plain = `${words(40, 'plain')}\n\nNo key material here.`;
    expect(credentialSafeProjection(plain)).toBe(plain);
  });
});

describe('chunkers cut from the projection', () => {
  test('markdown chunker at the default and a 512-token budget', () => {
    for (const opts of [undefined, { maxTokens: 512 }]) {
      const chunks = chunkText(PAGE_BODY, opts);
      expect(chunks.length).toBeGreaterThan(1);
      expect(leakedFragments(chunks.map(c => c.text))).toEqual([]);
    }
  });

  test('a key inside a recognized fenced code block', async () => {
    const body = `## Config\n\n${words(30, 'cfg')}\n\n\`\`\`yaml\nservice:\n  name: deploy\n  key: |\n${KEY.split('\n').map(l => `    ${l}`).join('\n')}\n\`\`\`\n\n${words(30, 'tail')}\n`;
    const chunks = await prepareMarkdownChunks({ compiled_truth: body, timeline: '' });
    expect(chunks.some(c => c.chunk_source === 'fenced_code')).toBe(true);
    expect(leakedFragments(chunks.map(c => c.chunk_text))).toEqual([]);
  });

  test('code chunker keeps symbol line numbers after the key', async () => {
    const source = `export const DEPLOY_KEY = \`\n${KEY}\`;\n\nexport function rotateDeployKey(input: number): number {\n  const next = input + 1;\n  return next * 2;\n}\n`;
    const prepared = await prepareCodeChunks({ compiled_truth: source }, 'src/deploy-keys.ts');
    expect(leakedFragments(prepared.chunks.map(c => c.chunk_text))).toEqual([]);
    const fn = prepared.chunks.find(c => c.symbol_name === 'rotateDeployKey');
    expect(fn?.start_line).toBe(source.split('\n').findIndex(l => l.startsWith('export function rotateDeployKey')) + 1);
  });

  test('evidence page text is the same projection', () => {
    const { text } = pageEvidenceText({ compiled_truth: PAGE_BODY, timeline: '' }, false);
    expect(leakedFragments(text)).toEqual([]);
    expect(text).toBe(credentialSafeProjection(PAGE_BODY));
  });
});

describe('retrieval ops over a stored key (PGLite)', () => {
  let engine: PGLiteEngine;
  const op = (name: string) => operations.find(o => o.name === name)!;
  const meta: Array<{ key: string; value: unknown }> = [];
  const ctxOf = (remote: boolean): OperationContext => ({
    engine: engine as never, config: {} as never, logger: console as never, dryRun: false, remote, sourceId: 'default',
    emitResponseMeta: (key: string, value: unknown) => { meta.push({ key, value }); },
  } as OperationContext);
  // A token from the middle of the key body, so ranking reaches chunks that hold neither fence.
  const bodyToken = KEY_LINES[Math.floor(KEY_LINES.length / 2)].slice(0, 40).replace(/[+/=]/g, ' ').trim().split(' ')[0];

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('search.mcp_keyword_only', 'true');
    const imported = await importFromContent(engine, 'notes/deploy-runbook', `---\ntitle: Deploy runbook\ntype: note\n---\n\n${PAGE_BODY}`, { noEmbed: true });
    expect(imported.status).toBe('imported');
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('stored chunks hold no fragment', async () => {
    const chunks = await engine.getChunks('notes/deploy-runbook', { sourceId: 'default', includeUnsealed: true });
    expect(chunks.length).toBeGreaterThan(1);
    expect(leakedFragments(chunks.map(c => c.chunk_text))).toEqual([]);
  });

  for (const remote of [false, true]) {
    test(`search, query and recall return no fragment (remote=${remote})`, async () => {
      for (const query of ['alpha3 deploy', 'omega7 rotation', bodyToken]) {
        const outputs = [
          await op('search').handler(ctxOf(remote), { query }),
          await op('query').handler(ctxOf(remote), { query, expand: false }),
          await op('recall').handler(ctxOf(remote), { query }),
        ];
        expect(leakedFragments(outputs), `query ${query}`).toEqual([]);
      }
    });

    test(`evidence delivery in every unit with a tight budget (remote=${remote})`, async () => {
      for (const unit of ['window', 'section', 'page'] as const) {
        for (const query of ['alpha3 deploy', 'omega7 rotation', bodyToken]) {
          const rows = await op('search').handler(ctxOf(remote), { query, return_unit: unit, return_window: 1, token_budget: 400 }) as Array<SearchResult & { delivered?: { unit: string; fallback_reason?: string } }>;
          expect(leakedFragments(rows), `${unit} ${query}`).toEqual([]);
          for (const row of rows) expect(row.delivered?.fallback_reason, `${unit} ${query}`).not.toBe('anchor_not_located');
        }
      }
    });
  }
});
