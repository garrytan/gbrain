// v0.40.6.0 — mutate-audit.ts contract tests.
//
// Pins privacy redaction (sha8 + first-slug-only), success+failure
// logging, ISO-week rotation, GBRAIN_AUDIT_DIR honoring, and the
// summarizeMutations() shape that doctor + a future audit CLI both bind to.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeMutateAuditPath,
  logMutationFailure,
  logMutationSuccess,
  readRecentMutations,
  summarizeMutations,
  type MutationAuditRecord,
} from '../src/core/schema-pack/mutate-audit.ts';
import { withEnv } from './helpers/with-env.ts';

let auditDir: string;

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-mutate-audit-test-'));
});

afterEach(() => {
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

describe('privacy posture', () => {
  it('redacts type name to sha8 by default', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir, GBRAIN_SCHEMA_AUDIT_VERBOSE: undefined }, async () => {
      await logMutationSuccess({
        op: 'add_type',
        pack: 'my-pack',
        type: 'mental_health_diagnosis',
        prefix: 'personal/health/oncology/2026-05-23.md',
        actor: 'cli',
      });
      const path = computeMutateAuditPath();
      const raw = readFileSync(path, 'utf-8');
      const record = JSON.parse(raw.trim()) as MutationAuditRecord;
      expect(record.type_redacted).toBe(true);
      expect(record.type_or_hash).toMatch(/^[0-9a-f]{8}$/);
      expect(record.type_or_hash).not.toBe('mental_health_diagnosis');
      expect(record.prefix_first_seg).toBe('personal');
      expect(raw).not.toContain('oncology');
      expect(raw).not.toContain('mental_health');
    });
  });

  it('writes raw type name when GBRAIN_SCHEMA_AUDIT_VERBOSE=1', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir, GBRAIN_SCHEMA_AUDIT_VERBOSE: '1' }, async () => {
      await logMutationSuccess({
        op: 'add_type',
        pack: 'my-pack',
        type: 'researcher',
        prefix: 'people/researchers/',
        actor: 'cli',
      });
      const record = JSON.parse(
        readFileSync(computeMutateAuditPath(), 'utf-8').trim(),
      ) as MutationAuditRecord;
      expect(record.type_redacted).toBe(false);
      expect(record.type_or_hash).toBe('researcher');
    });
  });

  it('pack name is NEVER redacted (it is user-chosen and non-PII)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      await logMutationSuccess({ op: 'add_type', pack: 'my-pack', actor: 'cli' });
      const record = JSON.parse(
        readFileSync(computeMutateAuditPath(), 'utf-8').trim(),
      ) as MutationAuditRecord;
      expect(record.pack).toBe('my-pack');
    });
  });

  it('omits type_or_hash when op did not involve a type', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      // Hypothetical pack-level op (none today, but the shape must accept it).
      await logMutationSuccess({ op: 'add_type', pack: 'p', actor: 'cli' });
      const r = JSON.parse(readFileSync(computeMutateAuditPath(), 'utf-8').trim()) as MutationAuditRecord;
      expect(r.type_or_hash).toBeNull();
    });
  });
});

describe('success + failure logging', () => {
  it('logs success with outcome=success and reason=null', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      await logMutationSuccess({
        op: 'add_type',
        pack: 'my-pack',
        type: 'researcher',
        actor: 'cli',
        prev_sha8: 'aaaaaaaa',
        new_sha8: 'bbbbbbbb',
      });
      const r = JSON.parse(readFileSync(computeMutateAuditPath(), 'utf-8').trim()) as MutationAuditRecord;
      expect(r.outcome).toBe('success');
      expect(r.reason).toBeNull();
      expect(r.prev_sha8).toBe('aaaaaaaa');
      expect(r.new_sha8).toBe('bbbbbbbb');
    });
  });

  it('logs failure with outcome=failure + reason code (the C11 signal doctor reads)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      await logMutationFailure({
        op: 'add_type',
        pack: 'gbrain-base',
        type: 'researcher',
        actor: 'cli',
        reason: 'PACK_READONLY',
      });
      const r = JSON.parse(readFileSync(computeMutateAuditPath(), 'utf-8').trim()) as MutationAuditRecord;
      expect(r.outcome).toBe('failure');
      expect(r.reason).toBe('PACK_READONLY');
    });
  });

  it('actor field surfaces mcp:<clientId8> shape', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      await logMutationSuccess({
        op: 'add_type', pack: 'p', type: 't',
        actor: 'mcp:abc12345',
      });
      const r = JSON.parse(readFileSync(computeMutateAuditPath(), 'utf-8').trim()) as MutationAuditRecord;
      expect(r.actor).toBe('mcp:abc12345');
    });
  });
});

describe('ISO-week rotation + GBRAIN_AUDIT_DIR', () => {
  it('writes filename in the schema-mutations-YYYY-Www.jsonl shape', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const path = computeMutateAuditPath(new Date('2026-05-23T12:00:00Z'));
      expect(path).toMatch(/schema-mutations-2026-W\d{2}\.jsonl$/);
      expect(path.startsWith(auditDir)).toBe(true);
    });
  });

  it('honors GBRAIN_AUDIT_DIR override', async () => {
    const customDir = mkdtempSync(join(tmpdir(), 'gbrain-mutate-custom-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: customDir }, async () => {
        await logMutationSuccess({ op: 'add_type', pack: 'p', actor: 'cli' });
        const path = computeMutateAuditPath();
        expect(path.startsWith(customDir)).toBe(true);
        expect(existsSync(path)).toBe(true);
      });
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  it('readRecentMutations returns records sorted within file, skips malformed lines', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      await logMutationSuccess({ op: 'add_type', pack: 'a', actor: 'cli' });
      await logMutationFailure({ op: 'remove_type', pack: 'a', actor: 'cli', reason: 'TYPE_NOT_FOUND' });
      // Inject malformed line.
      const path = computeMutateAuditPath();
      writeFileSync(path, readFileSync(path, 'utf-8') + 'not-json{{{\n' + '{}\n');
      const recs = readRecentMutations(7);
      expect(recs.length).toBeGreaterThanOrEqual(2);
      expect(recs.some((r) => r.outcome === 'success')).toBe(true);
      expect(recs.some((r) => r.outcome === 'failure')).toBe(true);
    });
  });
});

describe('summarizeMutations — cross-surface parity primitive', () => {
  it('aggregates by op, outcome, pack, reason, actor', () => {
    const recs: MutationAuditRecord[] = [
      { ts: '2026-01-01T00:00:00Z', op: 'add_type', pack: 'a', type_or_hash: null, type_redacted: true, prefix_first_seg: null, actor: 'cli', outcome: 'success', reason: null, prev_sha8: null, new_sha8: null, batch_id: null },
      { ts: '2026-01-01T00:00:01Z', op: 'add_type', pack: 'a', type_or_hash: null, type_redacted: true, prefix_first_seg: null, actor: 'mcp:abc12345', outcome: 'failure', reason: 'PACK_READONLY', prev_sha8: null, new_sha8: null, batch_id: 'batch-1' },
      { ts: '2026-01-01T00:00:02Z', op: 'remove_type', pack: 'b', type_or_hash: null, type_redacted: true, prefix_first_seg: null, actor: 'autopilot', outcome: 'success', reason: null, prev_sha8: null, new_sha8: null, batch_id: null },
    ];
    const s = summarizeMutations(recs);
    expect(s.total).toBe(3);
    expect(s.by_op.add_type).toBe(2);
    expect(s.by_op.remove_type).toBe(1);
    expect(s.by_outcome).toEqual({ success: 2, failure: 1 });
    expect(s.by_pack).toEqual({ a: 2, b: 1 });
    expect(s.by_reason).toEqual({ PACK_READONLY: 1 });
    // Actor bucketing collapses mcp:* to 'mcp'
    expect(s.by_actor).toEqual({ cli: 1, mcp: 1, autopilot: 1 });
  });

  it('returns empty summary for empty input', () => {
    const s = summarizeMutations([]);
    expect(s.total).toBe(0);
    expect(s.by_outcome).toEqual({ success: 0, failure: 0 });
  });
});

describe('best-effort behavior', () => {
  it('does not throw when the audit dir is unwritable', async () => {
    // Point at a path that fs.mkdirSync will fail on (e.g. a regular file).
    const fakeDir = join(mkdtempSync(join(tmpdir(), 'gbrain-mutate-baddir-')), 'not-a-dir');
    writeFileSync(fakeDir, 'this-is-a-file-not-a-dir', 'utf-8');
    await withEnv({ GBRAIN_AUDIT_DIR: fakeDir }, async () => {
      // Should NOT throw — best-effort posture.
      await expect(logMutationSuccess({ op: 'add_type', pack: 'p', actor: 'cli' })).resolves.toBeUndefined();
    });
  });
});
