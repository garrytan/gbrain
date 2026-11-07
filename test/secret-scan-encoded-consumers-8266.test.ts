/** #8266: real file scan, transcript ingest and installed-base audit read-back. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { scanFiles } from '../src/core/secret-scan.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { auditTranscriptSecrets, saveTranscriptSecretAudit, TRANSCRIPT_SECRET_AUDIT_VERSION } from '../src/core/transcripts/secret-audit.ts';
import { transcriptSecretExposureCheck } from '../src/commands/doctor/checks/transcript-secrets.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { alnum } from './helpers/provider-keys.ts';

let engine: PGLiteEngine;
let root: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'encoded-credential-consumers-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => {
  await engine?.disconnect();
  rmSync(root, { recursive: true, force: true });
});

test('#8266 file gate detects wire spelling; ingest stores placeholders and idempotently replays', async () => {
  const key = ['ghp', alnum(36)].join('_');
  const token = `${alnum(30)}\\/${alnum(24)}`;
  const body = `Keep useful deployment context.\nGITHUB_TOKEN=3D${key}\ncolour=\x1b[32m${key}\nBearer%20${token}`;
  const path = join(root, 'session.jsonl');
  const wire = join(root, 'wire.txt');
  writeFileSync(wire, body);
  const line = (role: 'user' | 'assistant', content: string, second: string) => JSON.stringify({
    type: role, uuid: `synthetic-${second}`, timestamp: `2026-10-01T09:00:${second}.000Z`,
    sessionId: 'encoded-credential-example', message: { role, content },
  });
  writeFileSync(path, [line('user', body, '00'), line('assistant', `echo_${token}; context retained.`, '01')].join('\n') + '\n');
  const findings = scanFiles([wire], { workspaceRoot: root });
  expect(findings.map(f => f.pattern)).toEqual(['github_token', 'github_token', 'bearer']);
  expect(JSON.stringify(findings)).not.toContain(key);
  expect(JSON.stringify(findings)).not.toContain(token.slice(32));
  const opts = { paths: [path], sourceId: 'default', userPatternsPath: join(root, 'absent-patterns') };
  const result = await runTranscriptsIngest(engine, opts);
  expect(result.sessionsImported).toBe(1);
  expect(result.pages.imported).toBe(1);
  const slug = result.slugsTouched[0]!;
  const page = await engine.getPage(slug, { sourceId: 'default' });
  expect(page!.compiled_truth).toContain('Keep useful deployment context.');
  // The importer's opt-in entropy lane also claims the encoded assignment prefix.
  expect(page!.compiled_truth).toContain('GITHUB_TOKEN=<REDACTED:high_entropy_assignment><REDACTED:github_token>');
  expect(page!.compiled_truth).toContain('Bearer%20<REDACTED:bearer>');
  expect(page!.compiled_truth).toContain('echo_<REDACTED:bearer>; context retained.');
  const stored = JSON.stringify({ page, raw: await engine.getRawData(slug, undefined, { sourceId: 'default' }) });
  expect(stored).not.toContain(key);
  expect(stored).not.toContain(token.slice(32));
  const retry = await runTranscriptsIngest(engine, opts);
  expect(retry.pages.imported).toBe(0);
  expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toBe(page!.compiled_truth);
}, 60_000);

test('#8266 old clean audit becomes stale; fresh audit finds historical encoded secrets without returning them', async () => {
  const key = ['ghp', alnum(36)].join('_');
  await engine.putPage('conversations/legacy-encoded-example', {
    type: 'conversation', title: 'Historical example', compiled_truth: `log\\U0001F600${key}`,
    frontmatter: { transcript_import: { harness: 'claude-code', session_id: 'legacy-example' } },
  }, { sourceId: 'default' });
  // Pin the historical version: deriving it from the current version would hide a missed bump.
  await saveTranscriptSecretAudit(engine, {
    detector_version: 3, scanned_at: new Date().toISOString(), source_id: null,
    pages_scanned: 2, pages_affected: 0, hits_total: 0, by_pattern: {}, pages: [],
  });
  const ctx = { engine, progress: { heartbeat() {} } } as unknown as DoctorContext;
  const stale = await transcriptSecretExposureCheck(ctx);
  expect(stale!.status).toBe('warn');
  const result = await auditTranscriptSecrets(engine);
  expect(TRANSCRIPT_SECRET_AUDIT_VERSION).toBe(4);
  expect(result.detector_version).toBe(4);
  expect(result.pages_affected).toBe(1);
  expect(result.by_pattern).toEqual({ github_token: 1 });
  expect(JSON.stringify(result)).not.toContain(key);
  expect(await saveTranscriptSecretAudit(engine, result)).toBe(true);
  const fresh = await transcriptSecretExposureCheck(ctx);
  expect(fresh!.status).toBe('warn');
  expect(fresh!.message).toContain('1 credential hit');
  expect(JSON.stringify(fresh)).not.toContain(key);
}, 60_000);
