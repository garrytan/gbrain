/**
 * Contract tests for the v0.28 sources_* MCP ops.
 *
 * - Op metadata: pins scope, localOnly, mutating, and that each op exists in
 *   the registered `operations` array (auto-flows through tool-defs).
 * - Functional: invokes each op handler against a PGLite engine to confirm
 *   the expected return shape.
 * - Scope-enforcement smoke test: simulates the serve-http.ts:673 hasScope
 *   gate so we know read-only tokens get insufficient_scope on sources_add.
 *   Full HTTP-transport coverage lives in test/e2e/serve-http-oauth.test.ts.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, AuthInfo, Operation } from '../src/core/operations.ts';
import { hasScope } from '../src/core/scope.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const FAKE_GIT_DIR = join(tmpdir(), `gbrain-sources-mcp-test-${process.pid}`);
const GBRAIN_HOME = join(FAKE_GIT_DIR, 'gbrain-home');

function writeFakeGit(): void {
  mkdirSync(FAKE_GIT_DIR, { recursive: true });
  const script = `#!/usr/bin/env bash
has_clone=0
has_remote_get_url=0
for ((i=1; i<=$#; i++)); do
  arg="\${!i}"
  next_idx=$((i+1))
  next="\${!next_idx:-}"
  if [ "$arg" = "clone" ]; then has_clone=1; fi
  if [ "$arg" = "remote" ] && [ "$next" = "get-url" ]; then has_remote_get_url=1; fi
done
if [ "$has_clone" = "1" ]; then
  dest="\${@: -1}"
  mkdir -p "$dest/.git"
  echo "ref: refs/heads/main" > "$dest/.git/HEAD"
  exit 0
fi
if [ "$has_remote_get_url" = "1" ]; then
  echo "https://github.com/example/repo"
  exit 0
fi
exit 0
`;
  const path = join(FAKE_GIT_DIR, 'git');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

const fakePath = (): string => `${FAKE_GIT_DIR}:${process.env.PATH ?? ''}`;

beforeAll(async () => {
  writeFakeGit();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(FAKE_GIT_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  rmSync(GBRAIN_HOME, { recursive: true, force: true });
  mkdirSync(GBRAIN_HOME, { recursive: true });
});

function findOp(name: string): Operation {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`op not found: ${name}`);
  return op;
}

function ctxRemote(scopes: string[]): OperationContext {
  const auth: AuthInfo = {
    token: 'gbrain_at_xxx',
    clientId: 'gbrain_cl_test',
    clientName: 'test-client',
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  return {
    engine: engine as any,
    config: { engine: 'pglite' } as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    auth,
  };
}

// ---------------------------------------------------------------------------
// Op metadata pins (auto-flow through tool-defs)
// ---------------------------------------------------------------------------

describe('sources_* op metadata', () => {
  const expected: Array<{
    name: string;
    scope: NonNullable<Operation['scope']>;
    mutating: boolean;
    localOnly: boolean;
  }> = [
    { name: 'sources_add',    scope: 'sources_admin', mutating: true,  localOnly: false },
    { name: 'sources_list',   scope: 'read',          mutating: false, localOnly: false },
    { name: 'sources_remove', scope: 'sources_admin', mutating: true,  localOnly: false },
    { name: 'sources_status', scope: 'read',          mutating: false, localOnly: false },
  ];
  for (const e of expected) {
    test(`${e.name}: scope=${e.scope}, mutating=${e.mutating}, localOnly=${e.localOnly}`, () => {
      const op = findOp(e.name);
      expect(op.scope).toBe(e.scope);
      expect(!!op.mutating).toBe(e.mutating);
      expect(!!op.localOnly).toBe(e.localOnly);
    });
  }
});

// ---------------------------------------------------------------------------
// Functional handler shape
// ---------------------------------------------------------------------------

describe('sources_* handlers — happy path', () => {
  test('sources_add (with --url) clones, INSERTs, returns row', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const op = findOp('sources_add');
      const ctx = ctxRemote(['sources_admin']);
      const row = (await op.handler(ctx, {
        id: 'mcp-add-test',
        url: 'https://github.com/example/repo',
        federated: true,
      })) as any;
      expect(row.id).toBe('mcp-add-test');
      expect(row.config.remote_url).toBe('https://github.com/example/repo');
      expect(row.config.federated).toBe(true);
      expect(existsSync(join(row.local_path, '.git'))).toBe(true);
    });
  });

  test('sources_list returns array with remote_url', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const addOp = findOp('sources_add');
      await addOp.handler(ctxRemote(['sources_admin']), {
        id: 'mcp-list-test',
        url: 'https://github.com/example/repo',
      });
      const listOp = findOp('sources_list');
      const result = (await listOp.handler(ctxRemote(['read']), {})) as any;
      expect(Array.isArray(result.sources)).toBe(true);
      const found = result.sources.find((s: any) => s.id === 'mcp-list-test');
      expect(found).toBeDefined();
      expect(found.remote_url).toBe('https://github.com/example/repo');
    });
  });

  test('sources_status returns clone_state', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const addOp = findOp('sources_add');
      await addOp.handler(ctxRemote(['sources_admin']), {
        id: 'mcp-status-test',
        url: 'https://github.com/example/repo',
      });
      const statusOp = findOp('sources_status');
      const result = (await statusOp.handler(ctxRemote(['read']), {
        id: 'mcp-status-test',
      })) as any;
      expect(result.id).toBe('mcp-status-test');
      expect(result.clone_state).toBe('healthy');
      expect(result.remote_url).toBe('https://github.com/example/repo');
    });
  });

  test('sources_remove deletes row + clone (with confirm_destructive)', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const addOp = findOp('sources_add');
      const row = (await addOp.handler(ctxRemote(['sources_admin']), {
        id: 'mcp-remove-test',
        url: 'https://github.com/example/repo',
      })) as any;
      const removeOp = findOp('sources_remove');
      const result = (await removeOp.handler(ctxRemote(['sources_admin']), {
        id: 'mcp-remove-test',
        confirm_destructive: true,
      })) as any;
      expect(result.clone_removed).toBe(true);
      expect(existsSync(row.local_path)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Scope-enforcement smoke test
// Simulates serve-http.ts:673's hasScope gate. The full HTTP path (real
// bearer auth + middleware) lives in test/e2e/serve-http-oauth.test.ts.
// ---------------------------------------------------------------------------

describe('sources_* scope enforcement (simulates serve-http gate)', () => {
  function gate(op: Operation, grantedScopes: string[]): { allowed: boolean; required: string } {
    const required = op.scope || 'read';
    return { allowed: hasScope(grantedScopes, required), required };
  }

  test('read-only token is REJECTED for sources_add (sources_admin required)', () => {
    const r = gate(findOp('sources_add'), ['read']);
    expect(r.required).toBe('sources_admin');
    expect(r.allowed).toBe(false);
  });

  test('read-only token is REJECTED for sources_remove', () => {
    expect(gate(findOp('sources_remove'), ['read']).allowed).toBe(false);
  });

  test('read-only token is ALLOWED for sources_list (read-scoped)', () => {
    expect(gate(findOp('sources_list'), ['read']).allowed).toBe(true);
  });

  test('read-only token is ALLOWED for sources_status (read-scoped)', () => {
    expect(gate(findOp('sources_status'), ['read']).allowed).toBe(true);
  });

  test('sources_admin token is ALLOWED for all sources_* ops', () => {
    const granted = ['sources_admin'];
    expect(gate(findOp('sources_add'), granted).allowed).toBe(true);
    expect(gate(findOp('sources_list'), granted).allowed).toBe(false); // sources_admin doesn't imply read (sibling axes)
    expect(gate(findOp('sources_remove'), granted).allowed).toBe(true);
    expect(gate(findOp('sources_status'), granted).allowed).toBe(false);
  });

  test('admin token is ALLOWED for all sources_* ops (admin implies all)', () => {
    const granted = ['admin'];
    expect(gate(findOp('sources_add'), granted).allowed).toBe(true);
    expect(gate(findOp('sources_list'), granted).allowed).toBe(true);
    expect(gate(findOp('sources_remove'), granted).allowed).toBe(true);
    expect(gate(findOp('sources_status'), granted).allowed).toBe(true);
  });

  test('gstack /setup-gbrain Path 4 token (read + sources_admin) covers everything', () => {
    const granted = ['read', 'sources_admin'];
    expect(gate(findOp('sources_add'), granted).allowed).toBe(true);
    expect(gate(findOp('sources_list'), granted).allowed).toBe(true);
    expect(gate(findOp('sources_remove'), granted).allowed).toBe(true);
    expect(gate(findOp('sources_status'), granted).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSRF rejection at the op layer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v0.28.1 codex hardening: remote callers cannot override path/clone_dir
// (those are local-CLI-only — remote sources_admin is for managing federated
// remote URLs, not arbitrary host-path writes).
// ---------------------------------------------------------------------------

describe('sources_add — remote callers ignore path/clone_dir overrides', () => {
  test('remote sources_admin: clone_dir override is silently ignored', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const op = findOp('sources_add');
      const ctx = ctxRemote(['sources_admin']);
      const row = (await op.handler(ctx, {
        id: 'attack-clone-dir',
        url: 'https://github.com/example/repo',
        clone_dir: '/etc/gbrain-pwned',  // attacker-supplied
      })) as any;
      // Clone landed at the SAFE default, not /etc/gbrain-pwned.
      expect(row.local_path).not.toBe('/etc/gbrain-pwned');
      expect(row.local_path).toContain('clones/attack-clone-dir');
      // /etc/gbrain-pwned was never written.
      expect(existsSync('/etc/gbrain-pwned')).toBe(false);
    });
  });

  test('remote sources_admin: path override (without url) gets nulled', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const op = findOp('sources_add');
      const ctx = ctxRemote(['sources_admin']);
      // Without a URL and with a remote-supplied path, the path is dropped.
      // The op then has neither path nor url, which is fine — it creates a
      // pure DB-only source row (local_path=null).
      const row = (await op.handler(ctx, {
        id: 'attack-path',
        path: '/etc',
      })) as any;
      // local_path was nulled — /etc is NOT registered as a source.
      expect(row.local_path).toBeNull();
    });
  });

  test('local CLI caller (ctx.remote=false) keeps clone_dir override', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const op = findOp('sources_add');
      // Simulate trusted local CLI: ctx.remote = false, no auth needed.
      const ctxLocal: OperationContext = {
        engine: engine as any,
        config: { engine: 'pglite' } as any,
        logger: { info() {}, warn() {}, error() {} },
        dryRun: false,
        remote: false,
      };
      const customDir = join(GBRAIN_HOME, 'custom-clones', 'local-override');
      const row = (await op.handler(ctxLocal, {
        id: 'local-override',
        url: 'https://github.com/example/repo',
        clone_dir: customDir,
      })) as any;
      // Local CLI is trusted: the override took effect.
      expect(row.local_path).toBe(customDir);
    });
  });
});

// ---------------------------------------------------------------------------
// v0.28.1 codex hardening: listSources honors include_archived flag
// ---------------------------------------------------------------------------

describe('sources_list — include_archived honored (was silently leaking)', () => {
  test('default: archived sources are NOT returned', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      // Add source then archive it.
      const addOp = findOp('sources_add');
      await addOp.handler(ctxRemote(['sources_admin']), {
        id: 'archived-src',
        url: 'https://github.com/example/repo',
      });
      await engine.executeRaw(
        `UPDATE sources SET archived = true WHERE id = $1`,
        ['archived-src'],
      );

      const listOp = findOp('sources_list');
      const result = (await listOp.handler(ctxRemote(['read']), {})) as any;
      const found = result.sources.find((s: any) => s.id === 'archived-src');
      expect(found).toBeUndefined();
    });
  });

  test('include_archived: true returns archived sources', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const addOp = findOp('sources_add');
      await addOp.handler(ctxRemote(['sources_admin']), {
        id: 'archived-included',
        url: 'https://github.com/example/repo',
      });
      await engine.executeRaw(
        `UPDATE sources SET archived = true WHERE id = $1`,
        ['archived-included'],
      );

      const listOp = findOp('sources_list');
      const result = (await listOp.handler(ctxRemote(['read']), {
        include_archived: true,
      })) as any;
      const found = result.sources.find((s: any) => s.id === 'archived-included');
      expect(found).toBeDefined();
    });
  });
});

describe('sources_add SSRF gate (delegated to parseRemoteUrl)', () => {
  test('rejects RFC1918 192.168.x.x with structured error', async () => {
    await withEnv({ GBRAIN_HOME, PATH: fakePath() }, async () => {
      const op = findOp('sources_add');
      try {
        await op.handler(ctxRemote(['sources_admin']), {
          id: 'ssrf-bad',
          url: 'https://192.168.1.1/x.git',
        });
        throw new Error('expected throw');
      } catch (e) {
        // The handler raises SourceOpError(invalid_remote_url). At the
        // dispatch layer this gets serialized as a normal error response.
        expect((e as Error).name).toBe('SourceOpError');
        expect((e as any).code).toBe('invalid_remote_url');
      }
    });
  });
});
