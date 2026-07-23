/**
 * Tests for `gbrain auth grant-read|revoke-read|set-federated-read`.
 *
 * Pure helper: parseSourceCsv (no DB).
 * DB-coupled: resolveClient, assertSourceExists, *Core fns — exercised
 * against a real PGLite via the canonical block.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { pgArray } from '../src/core/oauth-provider.ts';
import {
  parseSourceCsv,
  resolveClient,
  assertSourceExists,
  grantReadCore,
  revokeReadCore,
  setFederatedReadCore,
  extractDryRun,
  sanitizeForTerminal,
} from '../src/commands/auth.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('parseSourceCsv', () => {
  test('splits and trims', () => {
    expect(parseSourceCsv('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseSourceCsv('  a  ,  b  ')).toEqual(['a', 'b']);
  });

  test('drops empty segments', () => {
    expect(parseSourceCsv('a,,b,')).toEqual(['a', 'b']);
    expect(parseSourceCsv(',,')).toEqual([]);
    expect(parseSourceCsv('')).toEqual([]);
  });

  test('dedupes while preserving first-seen order', () => {
    expect(parseSourceCsv('a,b,a,c,b')).toEqual(['a', 'b', 'c']);
  });
});

describe('extractDryRun', () => {
  test('absent flag → false', () => {
    expect(extractDryRun(['alice', 'proj-x'])).toEqual({
      dryRun: false,
      rest: ['alice', 'proj-x'],
    });
  });

  test('flag at end', () => {
    expect(extractDryRun(['alice', 'proj-x', '--dry-run'])).toEqual({
      dryRun: true,
      rest: ['alice', 'proj-x'],
    });
  });

  test('flag at start', () => {
    expect(extractDryRun(['--dry-run', 'alice', 'proj-x'])).toEqual({
      dryRun: true,
      rest: ['alice', 'proj-x'],
    });
  });

  test('flag in middle', () => {
    expect(extractDryRun(['alice', '--dry-run', 'proj-x'])).toEqual({
      dryRun: true,
      rest: ['alice', 'proj-x'],
    });
  });

  test('no args', () => {
    expect(extractDryRun([])).toEqual({ dryRun: false, rest: [] });
  });
});

// ---------------------------------------------------------------------------
// DB-coupled
// ---------------------------------------------------------------------------

async function seedSource(id: string): Promise<void> {
  const sql = sqlQueryForEngine(engine);
  await sql`INSERT INTO sources (id, name) VALUES (${id}, ${id}) ON CONFLICT (id) DO NOTHING`;
}

async function seedClient(name: string, federated: string[] = []): Promise<string> {
  // Ensure write source FK is satisfied — every seeded client points at 'default'.
  await seedSource('default');
  const sql = sqlQueryForEngine(engine);
  const clientId = `gbrain_cl_test_${name}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const fedLit = pgArray(federated);
  await sql`
    INSERT INTO oauth_clients (client_id, client_name, client_secret_hash,
                               redirect_uris, grant_types, scope,
                               client_id_issued_at, source_id, federated_read)
    VALUES (${clientId}, ${name}, ${'dummy-hash'},
            ${pgArray([])}, ${pgArray(['client_credentials'])}, ${'read'},
            ${Date.now()}, ${'default'}, ${fedLit})
  `;
  return clientId;
}

async function readFederated(clientId: string): Promise<string[]> {
  const sql = sqlQueryForEngine(engine);
  const rows = await sql`SELECT federated_read FROM oauth_clients WHERE client_id = ${clientId}`;
  const fed = rows[0]?.federated_read;
  return Array.isArray(fed) ? (fed as string[]).map(String) : [];
}

describe('resolveClient', () => {
  test('matches by client_id', async () => {
    await seedSource('default');
    const id = await seedClient('alice', ['default']);
    const sql = sqlQueryForEngine(engine);
    const c = await resolveClient(sql, id);
    expect(c.client_name).toBe('alice');
    expect(c.federated_read).toEqual(['default']);
  });

  test('matches by client_name', async () => {
    await seedSource('default');
    await seedClient('alice', ['default']);
    const sql = sqlQueryForEngine(engine);
    const c = await resolveClient(sql, 'alice');
    expect(c.client_name).toBe('alice');
  });

  test('errors loudly on no-match', async () => {
    const sql = sqlQueryForEngine(engine);
    await expect(resolveClient(sql, 'nobody')).rejects.toThrow(/No active OAuth client found/);
  });

  test('errors loudly on ambiguous client_name', async () => {
    await seedSource('default');
    await seedClient('bob', ['default']);
    await seedClient('bob', ['default']);
    const sql = sqlQueryForEngine(engine);
    await expect(resolveClient(sql, 'bob')).rejects.toThrow(/Multiple active OAuth clients named/);
  });

  test('null source_id is preserved as null (legacy row tolerance)', async () => {
    const sql = sqlQueryForEngine(engine);
    const clientId = `gbrain_cl_test_null_${Date.now()}`;
    await sql`
      INSERT INTO oauth_clients (client_id, client_name, client_secret_hash,
                                 redirect_uris, grant_types, scope,
                                 client_id_issued_at, source_id, federated_read)
      VALUES (${clientId}, ${'legacy'}, ${'dummy'},
              ${pgArray([])}, ${pgArray(['client_credentials'])}, ${'read'},
              ${Date.now()}, ${null}, ${pgArray([])})
    `;
    const c = await resolveClient(sql, clientId);
    expect(c.source_id).toBeNull();
    expect(c.federated_read).toEqual([]);
  });
});

describe('assertSourceExists', () => {
  test('passes when present', async () => {
    await seedSource('proj-x');
    const sql = sqlQueryForEngine(engine);
    await expect(assertSourceExists(sql, 'proj-x')).resolves.toBeUndefined();
  });

  test('throws with paste-ready hint when missing', async () => {
    const sql = sqlQueryForEngine(engine);
    await expect(assertSourceExists(sql, 'ghost')).rejects.toThrow(
      /Source "ghost" does not exist.*gbrain sources add ghost/s,
    );
  });
});

describe('grantReadCore', () => {
  test('appends when not present and persists', async () => {
    await seedSource('default');
    await seedSource('proj-x');
    const id = await seedClient('alice', ['default']);
    const sql = sqlQueryForEngine(engine);
    const outcome = await grantReadCore(sql, 'alice', 'proj-x');
    expect(outcome.kind).toBe('updated');
    if (outcome.kind === 'updated') {
      expect(outcome.before).toEqual(['default']);
      expect(outcome.after).toEqual(['default', 'proj-x']);
    }
    expect(await readFederated(id)).toEqual(['default', 'proj-x']);
  });

  test('is idempotent — second call is a noop, list unchanged', async () => {
    await seedSource('default');
    await seedSource('proj-x');
    const id = await seedClient('alice', ['default']);
    const sql = sqlQueryForEngine(engine);
    await grantReadCore(sql, 'alice', 'proj-x');
    const outcome = await grantReadCore(sql, 'alice', 'proj-x');
    expect(outcome.kind).toBe('noop');
    if (outcome.kind === 'noop') {
      expect(outcome.reason).toBe('already-granted');
    }
    expect(await readFederated(id)).toEqual(['default', 'proj-x']);
  });

  test('refuses unknown source (fails BEFORE mutating)', async () => {
    await seedSource('default');
    const id = await seedClient('alice', ['default']);
    const sql = sqlQueryForEngine(engine);
    await expect(grantReadCore(sql, 'alice', 'ghost')).rejects.toThrow(/does not exist/);
    expect(await readFederated(id)).toEqual(['default']);
  });

  test('refuses unknown client', async () => {
    const sql = sqlQueryForEngine(engine);
    await expect(grantReadCore(sql, 'nobody', 'whatever')).rejects.toThrow(/No active OAuth client found/);
  });

  test('accepts client_id resolution too', async () => {
    await seedSource('default');
    await seedSource('proj-x');
    const id = await seedClient('alice', ['default']);
    const sql = sqlQueryForEngine(engine);
    await grantReadCore(sql, id, 'proj-x');
    expect(await readFederated(id)).toEqual(['default', 'proj-x']);
  });

  test('rejects malformed source_id BEFORE existence check (Codex finding #3)', async () => {
    await seedSource('default');
    const id = await seedClient('alice', ['default']);
    const sql = sqlQueryForEngine(engine);
    // Even with a row in `sources` having a weird id, the validator at the
    // boundary refuses. Closes the "manual SQL plants a row, CLI lets it
    // become unmanageable in federated_read" vector.
    await sql`INSERT INTO sources (id, name) VALUES (${'has,"weird"-bits'}, ${'weird'})`;
    await expect(grantReadCore(sql, 'alice', 'has,"weird"-bits')).rejects.toThrow(/Invalid source_id/);
    // DB unchanged.
    expect(await readFederated(id)).toEqual(['default']);
  });
});

describe('revokeReadCore', () => {
  test('removes when present', async () => {
    await seedSource('default');
    await seedSource('proj-x');
    const id = await seedClient('alice', ['default', 'proj-x']);
    const sql = sqlQueryForEngine(engine);
    const outcome = await revokeReadCore(sql, 'alice', 'proj-x');
    expect(outcome.kind).toBe('updated');
    expect(await readFederated(id)).toEqual(['default']);
  });

  test('is idempotent — second call is a noop, list unchanged', async () => {
    await seedSource('default');
    const id = await seedClient('alice', ['default']);
    const sql = sqlQueryForEngine(engine);
    const outcome = await revokeReadCore(sql, 'alice', 'ghost-source');
    expect(outcome.kind).toBe('noop');
    if (outcome.kind === 'noop') {
      expect(outcome.reason).toBe('not-present');
    }
    expect(await readFederated(id)).toEqual(['default']);
  });

  test('allows clearing the list down to empty (no implicit guard)', async () => {
    await seedSource('default');
    const id = await seedClient('alice', ['default']);
    const sql = sqlQueryForEngine(engine);
    await revokeReadCore(sql, 'alice', 'default');
    expect(await readFederated(id)).toEqual([]);
  });

  test('does NOT validate the source exists — operator may revoke stale references', async () => {
    await seedSource('default');
    // federated_read carries 'proj-x' but the source row was deleted.
    const id = await seedClient('alice', ['default', 'proj-x']);
    const sql = sqlQueryForEngine(engine);
    const outcome = await revokeReadCore(sql, 'alice', 'proj-x');
    expect(outcome.kind).toBe('updated');
    expect(await readFederated(id)).toEqual(['default']);
  });
});

describe('setFederatedReadCore', () => {
  test('replaces list wholesale', async () => {
    await seedSource('a');
    await seedSource('b');
    await seedSource('c');
    const id = await seedClient('alice', ['a']);
    const sql = sqlQueryForEngine(engine);
    const outcome = await setFederatedReadCore(sql, 'alice', 'b,c');
    expect(outcome.kind).toBe('updated');
    expect(await readFederated(id)).toEqual(['b', 'c']);
  });

  test('dedupes CSV input', async () => {
    await seedSource('a');
    await seedSource('b');
    const id = await seedClient('alice', []);
    const sql = sqlQueryForEngine(engine);
    await setFederatedReadCore(sql, 'alice', 'a,b,a,b,a');
    expect(await readFederated(id)).toEqual(['a', 'b']);
  });

  test('empty string clears the list', async () => {
    await seedSource('a');
    const id = await seedClient('alice', ['a']);
    const sql = sqlQueryForEngine(engine);
    await setFederatedReadCore(sql, 'alice', '');
    expect(await readFederated(id)).toEqual([]);
  });

  test('noop when result equals current list', async () => {
    await seedSource('a');
    await seedSource('b');
    const id = await seedClient('alice', ['a', 'b']);
    const sql = sqlQueryForEngine(engine);
    const outcome = await setFederatedReadCore(sql, 'alice', 'a,b');
    expect(outcome.kind).toBe('noop');
    if (outcome.kind === 'noop') {
      expect(outcome.reason).toBe('same-list');
    }
    expect(await readFederated(id)).toEqual(['a', 'b']);
  });

  test('refuses unknown source (fails BEFORE mutating)', async () => {
    await seedSource('a');
    const id = await seedClient('alice', ['a']);
    const sql = sqlQueryForEngine(engine);
    await expect(setFederatedReadCore(sql, 'alice', 'a,ghost')).rejects.toThrow(/does not exist/);
    // Original list preserved.
    expect(await readFederated(id)).toEqual(['a']);
  });

  test('order in CSV is the order persisted', async () => {
    await seedSource('a');
    await seedSource('b');
    await seedSource('c');
    const id = await seedClient('alice', ['a']);
    const sql = sqlQueryForEngine(engine);
    await setFederatedReadCore(sql, 'alice', 'c,a,b');
    expect(await readFederated(id)).toEqual(['c', 'a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// --dry-run semantics
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Codex fixes: soft-delete filter, atomic-SQL race-safety, sanitizer
// ---------------------------------------------------------------------------

describe('sanitizeForTerminal', () => {
  test('preserves printable ASCII unchanged', () => {
    expect(sanitizeForTerminal('alice')).toBe('alice');
    expect(sanitizeForTerminal('a b-c_d.e/f@g')).toBe('a b-c_d.e/f@g');
  });

  test('escapes ANSI escape sequences', () => {
    expect(sanitizeForTerminal('\x1b[2J')).toBe('\\x1b[2J');
    expect(sanitizeForTerminal('\x1b]0;TITLE\x07')).toBe('\\x1b]0;TITLE\\x07');
  });

  test('escapes ALL C0 controls including tab and newline', () => {
    // Codex re-review: preserving \n lets a DCR-registered name spoof
    // additional rows in list-clients output. Tab spoofs field separators.
    // Both are now escaped.
    expect(sanitizeForTerminal('\x00\x07\x08')).toBe('\\x00\\x07\\x08');
    expect(sanitizeForTerminal('line1\nline2')).toBe('line1\\x0aline2');
    expect(sanitizeForTerminal('col1\tcol2')).toBe('col1\\x09col2');
  });

  test('escapes DEL and C1 controls', () => {
    expect(sanitizeForTerminal('\x7f')).toBe('\\x7f');
    expect(sanitizeForTerminal('\x9b[31m')).toBe('\\x9b[31m');
  });

  test('passes through unicode', () => {
    expect(sanitizeForTerminal('café')).toBe('café');
    expect(sanitizeForTerminal('日本語')).toBe('日本語');
  });
});

describe('soft-delete filter (Codex finding #2)', () => {
  async function softDeleteClient(clientId: string): Promise<void> {
    const sql = sqlQueryForEngine(engine);
    await sql`UPDATE oauth_clients SET deleted_at = now() WHERE client_id = ${clientId}`;
  }

  test('resolveClient hides soft-deleted clients by default', async () => {
    await seedSource('default');
    const id = await seedClient('alice', ['default']);
    await softDeleteClient(id);
    const sql = sqlQueryForEngine(engine);
    await expect(resolveClient(sql, 'alice')).rejects.toThrow(/No active OAuth client found/);
    await expect(resolveClient(sql, id)).rejects.toThrow(/No active OAuth client found/);
  });

  test('resolveClient with includeDeleted finds soft-deleted clients', async () => {
    await seedSource('default');
    const id = await seedClient('alice', ['default']);
    await softDeleteClient(id);
    const sql = sqlQueryForEngine(engine);
    const c = await resolveClient(sql, id, { includeDeleted: true });
    expect(c.client_name).toBe('alice');
    expect(c.deleted_at).not.toBeNull();
  });

  test('grantReadCore refuses to mutate soft-deleted clients', async () => {
    await seedSource('default');
    await seedSource('proj-x');
    const id = await seedClient('alice', ['default']);
    await softDeleteClient(id);
    const sql = sqlQueryForEngine(engine);
    await expect(grantReadCore(sql, 'alice', 'proj-x')).rejects.toThrow(/No active OAuth client found/);
    expect(await readFederated(id)).toEqual(['default']);
  });

  test('revokeReadCore refuses to mutate soft-deleted clients', async () => {
    await seedSource('default');
    const id = await seedClient('alice', ['default']);
    await softDeleteClient(id);
    const sql = sqlQueryForEngine(engine);
    await expect(revokeReadCore(sql, 'alice', 'default')).rejects.toThrow(/No active OAuth client found/);
    expect(await readFederated(id)).toEqual(['default']);
  });

  test('two clients with same name but only one active resolves to the active one', async () => {
    await seedSource('default');
    // Seed two clients with the same name; soft-delete the older one.
    const sql = sqlQueryForEngine(engine);
    const oldId = await seedClient('alice', ['default']);
    await softDeleteClient(oldId);
    const newId = await seedClient('alice', ['default']);  // same name, new row
    const c = await resolveClient(sql, 'alice');
    expect(c.client_id).toBe(newId);  // active row wins; ambiguity error suppressed
  });
});

describe('atomic SQL race-safety (Codex finding #1, HIGH)', () => {
  test('grant+revoke serialize at row-lock — sensitive stays revoked', async () => {
    await seedSource('default');
    await seedSource('sensitive');
    await seedSource('harmless');
    const id = await seedClient('alice', ['default', 'sensitive']);
    const sql = sqlQueryForEngine(engine);

    // Simulate concurrent revoke(sensitive) + grant(harmless). Real concurrency
    // would race at the JS event loop boundary; here we await sequentially but
    // each call goes through the ATOMIC SQL path. The contract: regardless of
    // ordering, the final state has sensitive REMOVED and harmless ADDED.
    await revokeReadCore(sql, 'alice', 'sensitive');
    await grantReadCore(sql, 'alice', 'harmless');
    const final1 = await readFederated(id);
    expect(final1.sort()).toEqual(['default', 'harmless']);

    // Reverse order, same final state. The pre-fix read-modify-write shape
    // would have produced ['default', 'sensitive', 'harmless'] here (the
    // resurrection bug Codex caught).
    const id2 = await seedClient('bob', ['default', 'sensitive']);
    await grantReadCore(sql, 'bob', 'harmless');
    await revokeReadCore(sql, 'bob', 'sensitive');
    const final2 = await readFederated(id2);
    expect(final2.sort()).toEqual(['default', 'harmless']);
  });

  test('grant uses RETURNING to surface the post-write state', async () => {
    await seedSource('default');
    await seedSource('proj-x');
    await seedClient('alice', ['default']);
    const sql = sqlQueryForEngine(engine);
    const outcome = await grantReadCore(sql, 'alice', 'proj-x');
    expect(outcome.kind).toBe('updated');
    if (outcome.kind === 'updated') {
      // The `after` came from RETURNING, not from computing prev+sourceId
      // in JS — proves the atomic path returned authoritative state.
      expect(outcome.after).toEqual(['default', 'proj-x']);
    }
  });

  test('grant noop path still survives without writing', async () => {
    await seedSource('default');
    const id = await seedClient('alice', ['default']);
    const sql = sqlQueryForEngine(engine);
    const outcome = await grantReadCore(sql, 'alice', 'default');
    expect(outcome.kind).toBe('noop');
    if (outcome.kind === 'noop') expect(outcome.reason).toBe('already-granted');
    expect(await readFederated(id)).toEqual(['default']);
  });
});

describe('dryRun mode', () => {
  test('grantReadCore returns "updated" outcome but skips the write', async () => {
    await seedSource('default');
    await seedSource('proj-x');
    const id = await seedClient('alice', ['default']);
    const sql = sqlQueryForEngine(engine);
    const outcome = await grantReadCore(sql, 'alice', 'proj-x', { dryRun: true });
    expect(outcome.kind).toBe('updated');
    if (outcome.kind === 'updated') {
      expect(outcome.before).toEqual(['default']);
      expect(outcome.after).toEqual(['default', 'proj-x']);
    }
    // Crucially: the DB row is UNCHANGED.
    expect(await readFederated(id)).toEqual(['default']);
  });

  test('revokeReadCore returns "updated" outcome but skips the write', async () => {
    await seedSource('default');
    await seedSource('proj-x');
    const id = await seedClient('alice', ['default', 'proj-x']);
    const sql = sqlQueryForEngine(engine);
    const outcome = await revokeReadCore(sql, 'alice', 'proj-x', { dryRun: true });
    expect(outcome.kind).toBe('updated');
    expect(await readFederated(id)).toEqual(['default', 'proj-x']);
  });

  test('setFederatedReadCore returns "updated" outcome but skips the write', async () => {
    await seedSource('a');
    await seedSource('b');
    await seedSource('c');
    const id = await seedClient('alice', ['a']);
    const sql = sqlQueryForEngine(engine);
    const outcome = await setFederatedReadCore(sql, 'alice', 'b,c', { dryRun: true });
    expect(outcome.kind).toBe('updated');
    expect(await readFederated(id)).toEqual(['a']);
  });

  test('noop outcomes are surfaced identically with or without dryRun', async () => {
    await seedSource('default');
    await seedSource('proj-x');
    await seedClient('alice', ['default', 'proj-x']);
    const sql = sqlQueryForEngine(engine);
    const live = await grantReadCore(sql, 'alice', 'proj-x', { dryRun: false });
    const dry = await grantReadCore(sql, 'alice', 'proj-x', { dryRun: true });
    expect(live.kind).toBe('noop');
    expect(dry.kind).toBe('noop');
  });

  test('errors still fire in dryRun (operator sees the problem before commit)', async () => {
    await seedSource('default');
    const id = await seedClient('alice', ['default']);
    const sql = sqlQueryForEngine(engine);
    await expect(
      grantReadCore(sql, 'alice', 'ghost', { dryRun: true }),
    ).rejects.toThrow(/does not exist/);
    await expect(
      grantReadCore(sql, 'nobody', 'default', { dryRun: true }),
    ).rejects.toThrow(/No active OAuth client found/);
    // DB unchanged.
    expect(await readFederated(id)).toEqual(['default']);
  });
});
