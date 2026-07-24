/**
 * #2098: thin-client routing dropped --source / GBRAIN_SOURCE / .gbrain-source.
 *
 * The local CLI path resolves source scope in makeContext (ctx.sourceId); the
 * thin-client route short-circuits before that and sent params verbatim, so
 * `gbrain query --source X` against a remote brain silently searched unscoped
 * (the server op ignores the unknown `source` key).
 *
 * applyThinClientSourceScope runs the engine-free tiers (flag → env → dotfile)
 * and maps the result onto the op's `source_id` wire param. These tests fail
 * without the fix (params.source_id stays undefined / params.source leaks).
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyThinClientSourceScope, parseOpArgs } from '../src/cli.ts';
import { operationsByName } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

const queryOp = operationsByName.query;

describe('applyThinClientSourceScope (#2098)', () => {
  test('--source maps onto the query op wire param source_id', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, () => {
      const params = parseOpArgs(queryOp, ['find things', '--source', 'wiki']);
      expect(params.source).toBe('wiki'); // pre-fix state: wrong key
      applyThinClientSourceScope(queryOp, params, '/');
      expect(params.source_id).toBe('wiki');
      expect('source' in params).toBe(false); // never leaks the unknown key
    });
  });

  test('GBRAIN_SOURCE env tier fires when no flag is passed', async () => {
    await withEnv({ GBRAIN_SOURCE: 'gstack' }, () => {
      const params = parseOpArgs(queryOp, ['find things']);
      applyThinClientSourceScope(queryOp, params, '/');
      expect(params.source_id).toBe('gstack');
    });
  });

  test('.gbrain-source dotfile tier fires when flag and env are absent', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, () => {
      const tmp = mkdtempSync(join(tmpdir(), 'gbrain-thin-scope-'));
      try {
        writeFileSync(join(tmp, '.gbrain-source'), 'essays\n');
        const params = parseOpArgs(queryOp, ['find things']);
        applyThinClientSourceScope(queryOp, params, tmp);
        expect(params.source_id).toBe('essays');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  test('explicit --source-id on the wire wins over ambient env scope', async () => {
    await withEnv({ GBRAIN_SOURCE: 'gstack' }, () => {
      const params = parseOpArgs(queryOp, ['find things', '--source-id', 'wiki']);
      applyThinClientSourceScope(queryOp, params, '/');
      expect(params.source_id).toBe('wiki');
    });
  });

  test('--source together with --source-id is rejected loudly', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, () => {
      const params = parseOpArgs(queryOp, ['q', '--source', 'a', '--source-id', 'b']);
      expect(() => applyThinClientSourceScope(queryOp, params, '/')).toThrow(/not both/);
    });
  });

  test('invalid --source value is rejected loudly', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, () => {
      const params = parseOpArgs(queryOp, ['q', '--source', 'Bad_Value!']);
      expect(() => applyThinClientSourceScope(queryOp, params, '/')).toThrow(/Invalid --source/);
    });
  });

  test('--source on an op with no source_id wire param errors instead of silently dropping', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, () => {
      const op = operationsByName.add_tag;
      expect('source_id' in op.params).toBe(false);
      const params = { slug: 'x', tag: 'y', source: 'wiki' };
      expect(() => applyThinClientSourceScope(op, params, '/')).toThrow(/--source/);
    });
  });

  test('ambient env scope on an op with no source_id wire param is ignored (no throw)', async () => {
    await withEnv({ GBRAIN_SOURCE: 'wiki' }, () => {
      const op = operationsByName.add_tag;
      const params: Record<string, unknown> = { slug: 'x', tag: 'y' };
      applyThinClientSourceScope(op, params, '/');
      expect(params.source_id).toBeUndefined();
    });
  });

  test('ops that declare their OWN source param are left untouched', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, () => {
      const op = operationsByName.put_raw_data;
      expect('source' in op.params).toBe(true);
      const params: Record<string, unknown> = { slug: 'x', source: 'crustdata', data: {} };
      applyThinClientSourceScope(op, params, '/');
      expect(params.source).toBe('crustdata');
      expect(params.source_id).toBeUndefined();
    });
  });

  test('get_skill: ambient scope never leaks into its non-scope source_id param', async () => {
    await withEnv({ GBRAIN_SOURCE: 'wiki' }, () => {
      const op = operationsByName.get_skill;
      expect('source_id' in op.params).toBe(true); // has the param, but it is a mode switch
      const params: Record<string, unknown> = { name: 'ingest' };
      applyThinClientSourceScope(op, params, '/');
      expect(params.source_id).toBeUndefined(); // would flip host catalog → brain-pack lookup
    });
  });

  test('get_skill: explicit --source errors instead of masquerading as --source-id', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, () => {
      const op = operationsByName.get_skill;
      const params: Record<string, unknown> = { name: 'ingest', source: 'wiki' };
      expect(() => applyThinClientSourceScope(op, params, '/')).toThrow(/--source-id/);
    });
  });

  test('get_skill: explicit --source-id passes through untouched', async () => {
    await withEnv({ GBRAIN_SOURCE: 'gstack' }, () => {
      const op = operationsByName.get_skill;
      const params: Record<string, unknown> = { name: 'ingest', source_id: 'wiki' };
      applyThinClientSourceScope(op, params, '/');
      expect(params.source_id).toBe('wiki');
    });
  });

  test('no scope from any tier leaves params unchanged', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, () => {
      const params = parseOpArgs(queryOp, ['find things']);
      applyThinClientSourceScope(queryOp, params, '/');
      expect(params.source_id).toBeUndefined();
    });
  });
});
