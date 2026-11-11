/**
 * Transcript redaction reads an identifier that ends in a bare `key` word (`SUPABASE_SERVICE_ROLE_KEY=`, `STRIPE_KEY=`,
 * `deploy-key:`) as a credential name, like `API_KEY=` and `DB_PASSWORD=`. The entropy, digit and length gates still
 * decide, so `MONKEY=`, a bare `KEY=`, short values and low-entropy values stay as written. Checked through the
 * render path and through a full ingest on each engine. Every value is minted at run time from a fixed seed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { redactSession } from '../src/core/transcripts/render.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function minted(seed: number, length: number): string {
  let s = seed, out = '';
  while (out.length < length) { s = (s * 1103515245 + 12345) % 2147483648; out += ALPHABET[s % ALPHABET.length]; }
  return /[0-9]/.test(out) ? out : out.slice(1) + '7';
}

const V = Array.from({ length: 12 }, (_, i) => minted(9001 + i * 77, 38));

const REDACTED: Array<[string, string, string]> = [
  ['a service-role key name', 'SUPABASE_SERVICE_ROLE_KEY=', V[0]!],
  ['a two-word key name', 'STRIPE_KEY=', V[1]!],
  ['an exported key name', 'export DEPLOY_KEY=', V[2]!],
  ['a lower-case yaml key name', 'github_deploy_key: ', V[3]!],
  ['a dashed json key name', '{"signing-key": "', V[4]!],
  ['a key name with a digit segment', 'S3_KEY = ', V[5]!],
  ['the existing api key name', 'API_KEY=', V[6]!],
  ['the existing password name', 'DB_PASSWORD=', V[7]!],
];

const KEPT: Array<[string, string]> = [
  ['a word that merely ends in key', `MONKEY=${V[8]}`],
  ['a word that ends in key, lower case', `turkey: ${V[9]}`],
  ['a bare key with no identifier prefix', `KEY=${V[10]}`],
  ['a key name whose word is not the last', `STRIPE_KEY_ID=${V[11]}`],
  ['a plain value', 'MONKEY=banana'],
  ['a short value', 'STRIPE_KEY=a1B2c3D4'],
  ['a low-entropy value', 'SERVICE_ROLE_KEY=aaaaaaaaaaaaaaaa1111'],
  ['a digitless identifier value', 'PRIMARY_KEY=DefaultAzureCredential'],
  ['an all-digit value', 'SORT_KEY=12345678901234567890'],
];

const session = (text: string): ParsedSession => ({
  meta: { harness: 'codex', sessionId: 'key-names-0001', startedAt: '2026-10-30T09:00:00.000Z' },
  messages: [{ role: 'user', timestamp: '2026-10-30T09:00:00.000Z', text }],
});
const rendered = (text: string) => redactSession(session(text), { patterns: [] });

describe('transcript redaction: identifiers ending in a key word', () => {
  for (const [name, prefix, value] of REDACTED) test(`${name} is redacted`, () => {
    const out = rendered(`config line: ${prefix}${value}`);
    expect(out.session.messages[0]!.text).not.toContain(value);
    expect(out.redactionCount).toBeGreaterThan(0);
  });

  for (const [name, line] of KEPT) test(`${name} stays as written`, () => {
    const out = rendered(`config line: ${line}`);
    expect(out.session.messages[0]!.text).toBe(`config line: ${line}`);
    expect(out.redactionCount).toBe(0);
  });
});

for (const kind of testBackends()) {
  describe(`transcripts ingest redacts key-named credentials (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let tmp: string;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      tmp = mkdtempSync(join(tmpdir(), 'gb-transcript-key-names-'));
    }, 120_000);
    afterAll(async () => { rmSync(tmp, { recursive: true, force: true }); await close?.(); });

    test('the imported page holds no key-named value and keeps the near-misses', async () => {
      const path = join(tmp, 'conversations.json');
      writeFileSync(path, JSON.stringify([{ uuid: 'key-names-1', name: 'Deploy notes', created_at: '2026-08-01T10:00:00Z',
        chat_messages: [
          { uuid: 'm1', sender: 'human', created_at: '2026-08-01T10:00:00Z', text: `SUPABASE_SERVICE_ROLE_KEY=${V[0]}\nSTRIPE_KEY=${V[1]}\nMONKEY=banana` },
          { uuid: 'm2', sender: 'assistant', created_at: '2026-08-01T10:00:30Z', text: 'Noted.' },
        ] }]));
      const r = await runTranscriptsIngest(engine, { paths: [path], sourceId: 'default', format: 'claude-export' });
      expect(r.sessionsImported).toBe(1);
      expect(r.redactions).toBeGreaterThanOrEqual(2);
      const rows = await engine.executeRaw<{ body: string }>(`SELECT compiled_truth || COALESCE(timeline, '') AS body FROM pages WHERE deleted_at IS NULL`);
      const body = rows.map(row => row.body).join('\n');
      expect(body).toContain('MONKEY=banana');
      expect(body).not.toContain(V[0]!);
      expect(body).not.toContain(V[1]!);
    }, 60_000);
  });
}
