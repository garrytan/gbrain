import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withEnv } from '../helpers/with-env.ts';
import {
  logAgentSubmission,
  readRecentAgentEvents,
  computeAuditFilename,
  type AgentAuditEvent,
} from '../../src/core/minions/agent-audit.ts';

// Wrap every test body's env mutation through `withEnv` (see R1 in
// scripts/check-test-isolation.sh). The audit helpers read GBRAIN_AUDIT_DIR
// at call time so the env shadow only needs to survive the duration of the
// log/read calls inside each test.
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audit-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function withAuditDir<T>(fn: () => T | Promise<T>): Promise<T> {
  return await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => await fn());
}

describe('agent-audit (v0.38 Slice 3 — D4 JSONL trail for submit_agent)', () => {
  describe('computeAuditFilename (ISO-week rotation)', () => {
    it('produces agent-jobs-YYYY-Www.jsonl shape', () => {
      const name = computeAuditFilename(new Date('2026-05-21T12:00:00Z'));
      expect(name).toMatch(/^agent-jobs-\d{4}-W\d{2}\.jsonl$/);
    });
    it('handles year-boundary edge correctly (ISO week of Dec 30)', () => {
      // Dec 30 2025 is a Tuesday; ISO week 1 of 2026 starts Mon Dec 29 2025.
      const name = computeAuditFilename(new Date('2025-12-30T12:00:00Z'));
      expect(name).toBe('agent-jobs-2026-W01.jsonl');
    });
  });

  describe('logAgentSubmission()', () => {
    it('writes a JSONL line with all expected fields', async () => {
      await withAuditDir(() => {
        logAgentSubmission({
          client_id: 'cursor-test',
          job_id: 42,
          model: 'openai:gpt-5.2',
          bound_tools: ['search', 'get_page'],
          bound_source: 'default',
          slug_prefixes: ['wiki/'],
          max_concurrent: 3,
          budget_remaining_cents: 425,
          prompt_byte_count: 128,
          outcome: 'submitted',
        });

        const file = path.join(tmpDir, computeAuditFilename());
        expect(fs.existsSync(file)).toBe(true);
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
        expect(lines.length).toBe(1);
        const ev = JSON.parse(lines[0]) as AgentAuditEvent;
        expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(ev.client_id).toBe('cursor-test');
        expect(ev.job_id).toBe(42);
        expect(ev.model).toBe('openai:gpt-5.2');
        expect(ev.bound_tools).toEqual(['search', 'get_page']);
        expect(ev.bound_source).toBe('default');
        expect(ev.slug_prefixes).toEqual(['wiki/']);
        expect(ev.max_concurrent).toBe(3);
        expect(ev.budget_remaining_cents).toBe(425);
        expect(ev.prompt_byte_count).toBe(128);
        expect(ev.outcome).toBe('submitted');
      });
    });

    it('appends multiple events to the same weekly file', async () => {
      await withAuditDir(() => {
        for (let i = 0; i < 3; i++) {
          logAgentSubmission({
            client_id: 'c',
            job_id: i,
            model: 'm',
            bound_tools: [],
            bound_source: null,
            slug_prefixes: [],
            max_concurrent: 1,
            budget_remaining_cents: null,
            prompt_byte_count: 0,
            outcome: 'submitted',
          });
        }
        const file = path.join(tmpDir, computeAuditFilename());
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
        expect(lines.length).toBe(3);
      });
    });

    it('NEVER logs prompt content (only byte count)', async () => {
      const secret = 'this is a private prompt that must never appear in audit';
      await withAuditDir(() => {
        logAgentSubmission({
          client_id: 'c',
          job_id: 1,
          model: 'm',
          bound_tools: [],
          bound_source: null,
          slug_prefixes: [],
          max_concurrent: 1,
          budget_remaining_cents: null,
          // Caller is expected to pre-compute byte count; audit module never sees prompt text.
          prompt_byte_count: Buffer.byteLength(secret, 'utf8'),
          outcome: 'submitted',
        });
        const file = path.join(tmpDir, computeAuditFilename());
        const content = fs.readFileSync(file, 'utf8');
        expect(content).not.toContain(secret);
        expect(content).toContain(`"prompt_byte_count":${Buffer.byteLength(secret, 'utf8')}`);
      });
    });
  });

  describe('readRecentAgentEvents()', () => {
    it('returns events written within the window, newest first', async () => {
      await withAuditDir(() => {
        logAgentSubmission({
          client_id: 'a',
          job_id: 1,
          model: 'm',
          bound_tools: [],
          bound_source: null,
          slug_prefixes: [],
          max_concurrent: 1,
          budget_remaining_cents: null,
          prompt_byte_count: 0,
          outcome: 'submitted',
        });
        // Sleep ~5ms so the second event has a strictly later ts.
        const t0 = Date.now();
        while (Date.now() - t0 < 5) { /* spin */ }
        logAgentSubmission({
          client_id: 'b',
          job_id: 2,
          model: 'm',
          bound_tools: [],
          bound_source: null,
          slug_prefixes: [],
          max_concurrent: 1,
          budget_remaining_cents: null,
          prompt_byte_count: 0,
          outcome: 'submitted',
        });

        const events = readRecentAgentEvents(7);
        expect(events.length).toBe(2);
        // Newest first.
        expect(events[0].client_id).toBe('b');
        expect(events[1].client_id).toBe('a');
      });
    });

    it('returns empty when audit dir doesnt exist yet', async () => {
      // tmpDir exists but no files written.
      await withAuditDir(() => {
        const events = readRecentAgentEvents(7);
        expect(events).toEqual([]);
      });
    });
  });
});
