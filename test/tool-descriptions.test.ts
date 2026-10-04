/**
 * F10 (agent operator contract v1): tool descriptions follow the template
 * `<what>. Use when <…>. Needs <key/scope>. On <error>: <next>.`, carry no
 * release prefixes or ticket jargon, and query/think state their key
 * dependence; list_jobs can project fields to save tokens.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { operations, operationsByName, type OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

const JARGON = /\bv\d+\.\d+|#\d{3,}|\bWP\d|\bD\d+\b|\bCX\d|\bENG-|amendment \d|codex [A-Z]\d/i;

describe('tool descriptions (F10)', () => {
  test('every description is at least 60 characters', () => {
    const short = operations.filter(op => (op.description ?? '').length < 60).map(op => op.name);
    expect(short).toEqual([]);
  });

  test('no release prefixes or ticket jargon', () => {
    const jargon = operations.filter(op => JARGON.test(op.description ?? '')).map(op => `${op.name}: ${op.description.match(JARGON)![0]}`);
    expect(jargon).toEqual([]);
  });

  test('query and think state their key dependence', () => {
    expect(operationsByName['query'].description).toContain('Needs an embedding key');
    expect(operationsByName['query'].description).toContain('keyword-only');
    expect(operationsByName['think'].description).toContain('Needs a chat-model API key (Anthropic or OpenAI)');
    expect(operationsByName['think'].description).toContain('keyless brain returns the gathered evidence');
  });

  test('rewritten short descriptions follow the template', () => {
    for (const name of ['add_tag', 'get_links', 'retry_job', 'resolve_slugs', 'file_url']) {
      const d = operationsByName[name].description;
      expect(d).toMatch(/\. Use when /);
      expect(d).toMatch(/Needs [a-z]+ scope/);
    }
  });
});

describe('list_jobs fields projection (F10 token trim)', () => {
  let engine: PGLiteEngine;
  let queue: MinionQueue;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    queue = new MinionQueue(engine);
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

  const list_jobs = operationsByName['list_jobs']!;
  const local = () => ({ engine, config: {}, logger: console, dryRun: false, remote: false, sourceId: 'default' }) as unknown as OperationContext;

  test('fields projects each job; omitted keeps every field; unknown names list the valid ones', async () => {
    await queue.add('subagent', { prompt: 'fields-1' }, { queue: 'default' }, { allowProtectedSubmit: true });
    const full = await list_jobs.handler(local(), {}) as Array<Record<string, unknown>>;
    expect(Object.keys(full[0])).toContain('data');
    const slim = await list_jobs.handler(local(), { fields: ['id', 'name', 'status'] }) as Array<Record<string, unknown>>;
    expect(Object.keys(slim[0]).sort()).toEqual(['id', 'name', 'status']);
    const csv = await list_jobs.handler(local(), { fields: 'id,status' }) as Array<Record<string, unknown>>;
    expect(Object.keys(csv[0]).sort()).toEqual(['id', 'status']);
    await expect(list_jobs.handler(local(), { fields: ['id', 'secret_sauce'] })).rejects.toMatchObject({
      code: 'invalid_params',
      suggestion: expect.stringContaining('Pass fields from: id, name'),
    });
    // Never a way around publicJob: the authority is not projectable, the owner token stays redacted.
    await expect(list_jobs.handler(local(), { fields: ['submission_authority'] })).rejects.toMatchObject({ code: 'invalid_params' });
    const tok = await list_jobs.handler(local(), { fields: ['private_queue_owner_token'] }) as Array<Record<string, unknown>>;
    expect([null, '[redacted]']).toContain(tok[0].private_queue_owner_token as string | null);
  });
});
