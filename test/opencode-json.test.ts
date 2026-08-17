/**
 * opencode-json.test.ts — pins the opencode config writer's safety
 * invariants (mirror of codex-toml.test.ts for the JSONC surface):
 * comment preservation via jsonc-parser surgical edits, the 4-state
 * ownership fingerprint (GBRAIN_SOURCE equality, [FIX7] parity), distinct
 * read-failure classes (ENOENT/empty/unreadable), foreign refusal on write
 * AND remove, post-render validation keeping the original on failure, 0600
 * hygiene only for inline-bearer entries, and CRLF/byte preservation
 * outside the edited range. Host-spec path helpers (XDG-only resolution,
 * jsonc-over-json preference) are pinned here too.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  opencodeEntryKind,
  opencodeEntrySnippet,
  parseOpencodeConfig,
  parseOpencodeEntryBearer,
  reconcileOpencodeSiblingGlobal,
  removeOpencodeMcpEntry,
  textCarriesInlineBearer,
  writeOpencodeMcpEntry,
  type OpencodeLocalEntry,
  type OpencodeRemoteEntry,
} from '../src/core/bootstrap/opencode-json.ts';
import {
  opencodeConfigDir,
  opencodeGlobalConfigPath,
  opencodeGlobalSiblingPath,
  opencodeProjectConfigPath,
  OPENCODE_SPEC_ID,
  TARGETS,
} from '../src/core/bootstrap/host-specs.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-opencode-json-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const localEntry = (over: Partial<OpencodeLocalEntry> = {}): OpencodeLocalEntry => ({
  kind: 'local',
  name: 'gbrain',
  command: ['/abs/path/gbrain', 'serve', '--surface', 'full'],
  environment: { GBRAIN_SOURCE: 'ws-a' },
  ...over,
});

const remoteInline = (over: Partial<OpencodeRemoteEntry> = {}): OpencodeRemoteEntry => ({
  kind: 'remote',
  name: 'gbrain',
  url: 'http://127.0.0.1:7411/mcp',
  tokenMode: 'inline',
  bearerToken: 'gbt_secret_token_1',
  ...over,
});

function cfg(name = 'opencode.json'): string {
  return join(dir, name);
}

describe('host-specs opencode path helpers', () => {
  test('spec target is registered and verified', () => {
    const t = TARGETS[OPENCODE_SPEC_ID];
    expect(t).toBeDefined();
    expect(t.status).toBe('verified');
    expect(t.references.join(' ')).toContain('OPENCODE-CLI-PIN.md');
  });

  test('config dir resolves via XDG_CONFIG_HOME, then HOME — OPENCODE_CONFIG* deliberately inert', async () => {
    await withEnv({
      OPENCODE_CONFIG: join(dir, 'somewhere-else.json'),
      OPENCODE_CONFIG_DIR: join(dir, 'somewhere-else'),
      XDG_CONFIG_HOME: join(dir, 'xdg'),
    }, () => {
      expect(opencodeConfigDir()).toBe(join(dir, 'xdg', 'opencode'));
    });
    await withEnv({
      OPENCODE_CONFIG: join(dir, 'somewhere-else.json'),
      OPENCODE_CONFIG_DIR: join(dir, 'somewhere-else'),
      XDG_CONFIG_HOME: undefined,
      HOME: join(dir, 'home'),
    }, () => {
      expect(opencodeConfigDir()).toBe(join(dir, 'home', '.config', 'opencode'));
    });
  });

  test('global path prefers the file that exists; .jsonc wins ties and fresh dirs (vendor parity)', async () => {
    await withEnv({ XDG_CONFIG_HOME: join(dir, 'xdg') }, () => {
      const ocDir = join(dir, 'xdg', 'opencode');
      // Fresh: .jsonc (what `opencode mcp add` itself writes).
      expect(opencodeGlobalConfigPath()).toBe(join(ocDir, 'opencode.jsonc'));
      // Only .json exists → edit it (one owner per entry, no split-brain).
      mkdirSync(ocDir, { recursive: true });
      writeFileSync(join(ocDir, 'opencode.json'), '{}');
      expect(opencodeGlobalConfigPath()).toBe(join(ocDir, 'opencode.json'));
      // Both exist → .jsonc wins.
      writeFileSync(join(ocDir, 'opencode.jsonc'), '{}');
      expect(opencodeGlobalConfigPath()).toBe(join(ocDir, 'opencode.jsonc'));
    });
  });

  test('project path is the docs-canonical opencode.json in the workspace root', () => {
    expect(opencodeProjectConfigPath('/ws')).toBe(join('/ws', 'opencode.json'));
  });
});

describe('read-failure classes are distinct', () => {
  test('ENOENT → fresh file created with $schema + our entry', () => {
    const res = writeOpencodeMcpEntry(cfg(), localEntry());
    expect(res.replacedPrior).toBe(false);
    expect(res.priorKind).toBe('absent');
    expect(res.backupPath).toBeNull();
    const parsed = parseOpencodeConfig(readFileSync(cfg(), 'utf8'), cfg());
    expect(parsed.$schema).toBe('https://opencode.ai/config.json');
    const entry = (parsed.mcp as Record<string, unknown>).gbrain as Record<string, unknown>;
    expect(entry.type).toBe('local');
    expect(entry.enabled).toBe(true);
  });

  test('empty/whitespace file → treated as {} (strict JSON.parse would wrongly refuse)', () => {
    writeFileSync(cfg(), '  \n\n');
    const res = writeOpencodeMcpEntry(cfg(), localEntry());
    expect(res.priorKind).toBe('absent');
    const parsed = parseOpencodeConfig(readFileSync(cfg(), 'utf8'), cfg());
    expect((parsed.mcp as Record<string, unknown>).gbrain).toBeDefined();
  });

  test('unreadable file → refuse loudly, never clobber', () => {
    if (process.getuid?.() === 0) return; // root ignores modes
    writeFileSync(cfg(), '{"mcp":{}}');
    chmodSync(cfg(), 0o000);
    try {
      expect(() => writeOpencodeMcpEntry(cfg(), localEntry())).toThrow(/cannot be read/);
    } finally {
      chmodSync(cfg(), 0o644);
    }
    expect(readFileSync(cfg(), 'utf8')).toBe('{"mcp":{}}');
  });

  test('file that fails even JSONC parsing → refuse with a paste-by-hand snippet', () => {
    writeFileSync(cfg(), '{"mcp": {{{');
    expect(() => writeOpencodeMcpEntry(cfg(), localEntry())).toThrow(/does not parse as JSONC[\s\S]*"mcp"/);
    expect(readFileSync(cfg(), 'utf8')).toBe('{"mcp": {{{');
  });
});

describe('JSONC comment + byte preservation (the opencode mcp add bar)', () => {
  test('comments, user keys, and foreign servers survive a write', () => {
    writeFileSync(
      cfg('opencode.jsonc'),
      `{
  // user comment: do not lose me
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark", // trailing comment
  "autoupdate": false,
  "mcp": {
    "other-server": { "type": "remote", "url": "https://other.example/mcp" }
  }
}
`,
    );
    const res = writeOpencodeMcpEntry(cfg('opencode.jsonc'), localEntry());
    expect(res.priorKind).toBe('absent');
    const text = readFileSync(cfg('opencode.jsonc'), 'utf8');
    expect(text).toContain('// user comment: do not lose me');
    expect(text).toContain('// trailing comment');
    const parsed = parseOpencodeConfig(text, cfg('opencode.jsonc'));
    expect(parsed.theme).toBe('dark');
    expect(parsed.autoupdate).toBe(false);
    const mcp = parsed.mcp as Record<string, unknown>;
    expect((mcp['other-server'] as Record<string, unknown>).url).toBe('https://other.example/mcp');
    expect((mcp.gbrain as Record<string, unknown>).type).toBe('local');
  });

  test('CRLF config keeps CRLF (jsonc-parser detects the file EOL)', () => {
    writeFileSync(cfg(), '{\r\n  "theme": "dark"\r\n}\r\n');
    writeOpencodeMcpEntry(cfg(), localEntry());
    const text = readFileSync(cfg(), 'utf8');
    expect(text).toContain('"theme": "dark",\r\n'); // comma added by the edit; CRLF preserved
    expect(text).not.toMatch(/[^\r]\n/); // no LF-only lines crept in
    const parsed = parseOpencodeConfig(text, cfg());
    expect((parsed.mcp as Record<string, unknown>).gbrain).toBeDefined();
  });

  test('second write is idempotent (replacedPrior, single entry, no growth)', () => {
    writeOpencodeMcpEntry(cfg(), localEntry());
    const first = readFileSync(cfg(), 'utf8');
    const res = writeOpencodeMcpEntry(cfg(), localEntry());
    expect(res.replacedPrior).toBe(true);
    expect(res.priorKind).toBe('ours-same-source');
    expect(readFileSync(cfg(), 'utf8')).toBe(first);
  });
});

describe('opencodeEntryKind — the ownership arbiter truth table', () => {
  const table: Array<{
    label: string;
    entry: unknown;
    expectArg: { sourceId?: string; url?: string };
    want: string;
  }> = [
    // local × command shapes (all with matching source)
    { label: 'local abs path + same source', entry: { type: 'local', command: ['/opt/bin/gbrain', 'serve'], environment: { GBRAIN_SOURCE: 'ws-a' } }, expectArg: { sourceId: 'ws-a' }, want: 'ours-same-source' },
    { label: 'local PATH-resolved + same source', entry: { type: 'local', command: ['gbrain', 'serve'], environment: { GBRAIN_SOURCE: 'ws-a' } }, expectArg: { sourceId: 'ws-a' }, want: 'ours-same-source' },
    { label: 'local bun-run wrapper + same source (gbrain path segment)', entry: { type: 'local', command: ['bun', 'run', '/repo/gbrain/src/cli.ts', 'serve'], environment: { GBRAIN_SOURCE: 'ws-a' } }, expectArg: { sourceId: 'ws-a' }, want: 'ours-same-source' },
    // [anchored bun-arg fingerprint] a loose substring scan classified a
    // gbrainy-fork checkout as ours; the anchor requires an exact `gbrain`
    // (or `gbrain-*`) path segment in some arg — a gbrain-less cli path is
    // fail-closed NOT ours.
    { label: 'local bun-run of a gbrainy-fork cli is NOT ours', entry: { type: 'local', command: ['bun', 'run', '/opt/gbrainy-fork/src/cli.ts', 'serve'], environment: { GBRAIN_SOURCE: 'ws-a' } }, expectArg: { sourceId: 'ws-a' }, want: 'foreign' },
    { label: 'local bun-run with NO gbrain-ish segment is NOT ours (fail-closed)', entry: { type: 'local', command: ['bun', 'run', '/repo/src/cli.ts', 'serve'], environment: { GBRAIN_SOURCE: 'ws-a' } }, expectArg: { sourceId: 'ws-a' }, want: 'foreign' },
    { label: 'local bun-run of a gbrain-shim path is ours', entry: { type: 'local', command: ['bun', 'run', '/tmp/stage/gbrain-shim', 'serve'], environment: { GBRAIN_SOURCE: 'ws-a' } }, expectArg: { sourceId: 'ws-a' }, want: 'ours-same-source' },
    { label: 'local staged shim + same source', entry: { type: 'local', command: ['/tmp/stage/gbrain', 'serve'], environment: { GBRAIN_SOURCE: 'ws-a' } }, expectArg: { sourceId: 'ws-a' }, want: 'ours-same-source' },
    // source equality, not presence ([FIX7])
    { label: 'local + OTHER source', entry: { type: 'local', command: ['gbrain', 'serve'], environment: { GBRAIN_SOURCE: 'ws-b' } }, expectArg: { sourceId: 'ws-a' }, want: 'ours-other-source' },
    { label: 'local + no expectation → ours', entry: { type: 'local', command: ['gbrain', 'serve'], environment: { GBRAIN_SOURCE: 'ws-b' } }, expectArg: {}, want: 'ours-same-source' },
    // foreign local shapes
    { label: 'local non-gbrain command', entry: { type: 'local', command: ['npx', 'other-mcp'], environment: { GBRAIN_SOURCE: 'ws-a' } }, expectArg: { sourceId: 'ws-a' }, want: 'foreign' },
    { label: 'local gbrain command but NO GBRAIN_SOURCE', entry: { type: 'local', command: ['gbrain', 'serve'], environment: {} }, expectArg: { sourceId: 'ws-a' }, want: 'foreign' },
    { label: 'local gbrain-prefixed foreign binary is NOT ours', entry: { type: 'local', command: ['/opt/bin/gbrainy', 'serve'], environment: { GBRAIN_SOURCE: 'ws-a' } }, expectArg: { sourceId: 'ws-a' }, want: 'foreign' },
    // kind mismatch (red-team): a remote expectation finding a LOCAL gbrain
    // entry (and vice versa) is ANOTHER lane's registration — never a silent
    // same-source match (which would replace it, and --remove would delete it).
    { label: 'local entry + remote expectation (url) → ours-other-source, never silently replaceable', entry: { type: 'local', command: ['gbrain', 'serve'], environment: { GBRAIN_SOURCE: 'ws-a' } }, expectArg: { url: 'http://h:1/mcp' }, want: 'ours-other-source' },
    { label: 'remote env-interpolated entry + local expectation (sourceId) → ours-other-source', entry: { type: 'remote', url: 'http://h:9/mcp', headers: { Authorization: 'Bearer {env:GBRAIN_REMOTE_TOKEN}' } }, expectArg: { sourceId: 'ws-a' }, want: 'ours-other-source' },
    // remote
    { label: 'remote url matches receipt', entry: { type: 'remote', url: 'http://h:1/mcp', headers: { Authorization: 'Bearer abc' } }, expectArg: { url: 'http://h:1/mcp' }, want: 'ours-same-source' },
    { label: 'remote url differs from receipt, opaque token', entry: { type: 'remote', url: 'http://h:2/mcp', headers: { Authorization: 'Bearer abc' } }, expectArg: { url: 'http://h:1/mcp' }, want: 'foreign' },
    { label: 'remote env-interpolated token, no receipt → connect-lane ours', entry: { type: 'remote', url: 'http://h:9/mcp', headers: { Authorization: 'Bearer {env:GBRAIN_REMOTE_TOKEN}' } }, expectArg: {}, want: 'ours-same-source' },
    { label: 'remote env-interpolated token + expect url DIFFERENT from entry url → ours-other-source', entry: { type: 'remote', url: 'http://h:9/mcp', headers: { Authorization: 'Bearer {env:GBRAIN_REMOTE_TOKEN}' } }, expectArg: { url: 'http://h:1/mcp' }, want: 'ours-other-source' },
    { label: 'remote plain foreign', entry: { type: 'remote', url: 'https://other.example/mcp', headers: {} }, expectArg: {}, want: 'foreign' },
    // degenerate shapes
    { label: 'unknown type', entry: { type: 'websocket', url: 'x' }, expectArg: {}, want: 'foreign' },
    { label: 'non-object entry', entry: 'oops', expectArg: {}, want: 'foreign' },
  ];

  for (const row of table) {
    test(row.label, () => {
      const parsed = { mcp: { gbrain: row.entry } } as Record<string, unknown>;
      expect(opencodeEntryKind(parsed, 'gbrain', row.expectArg)).toBe(row.want as never);
    });
  }

  test('absent: no mcp table / no entry', () => {
    expect(opencodeEntryKind({}, 'gbrain')).toBe('absent');
    expect(opencodeEntryKind({ mcp: {} }, 'gbrain')).toBe('absent');
  });
});

describe('foreign + other-source gating on write', () => {
  test('foreign same-name entry → refuse, file untouched', () => {
    writeFileSync(cfg(), '{"mcp":{"gbrain":{"type":"local","command":["npx","other"],"environment":{}}}}');
    const before = readFileSync(cfg(), 'utf8');
    expect(() => writeOpencodeMcpEntry(cfg(), localEntry())).toThrow(/not a gbrain-managed entry/);
    expect(readFileSync(cfg(), 'utf8')).toBe(before);
  });

  test('ours-other-source → refuse without the confirmation flag, replace with it', () => {
    writeFileSync(cfg(), '{"mcp":{"gbrain":{"type":"local","command":["gbrain","serve"],"environment":{"GBRAIN_SOURCE":"ws-b"}}}}');
    expect(() =>
      writeOpencodeMcpEntry(cfg(), localEntry(), { expect: { sourceId: 'ws-a' } }),
    ).toThrow(/DIFFERENT gbrain workspace/);
    const res = writeOpencodeMcpEntry(cfg(), localEntry(), {
      expect: { sourceId: 'ws-a' },
      allowReplaceOtherSource: true,
    });
    expect(res.priorKind).toBe('ours-other-source');
    expect(res.notes.join(' ')).toContain('different workspace');
    const parsed = parseOpencodeConfig(readFileSync(cfg(), 'utf8'), cfg());
    const env = ((parsed.mcp as Record<string, unknown>).gbrain as { environment: Record<string, string> }).environment;
    expect(env.GBRAIN_SOURCE).toBe('ws-a');
  });
});

describe('secret hygiene (inline bearer only)', () => {
  test('inline bearer → file forced 0600, .bak 0600 on re-runs', () => {
    writeFileSync(cfg(), '{"theme":"dark"}');
    chmodSync(cfg(), 0o644);
    const res1 = writeOpencodeMcpEntry(cfg(), remoteInline());
    expect(statSync(cfg()).mode & 0o777).toBe(0o600);
    expect(res1.notes.join(' ')).toContain('0600');
    // Re-run replaces the token; the .bak carries the PREVIOUS one → 0600.
    const res2 = writeOpencodeMcpEntry(cfg(), remoteInline({ bearerToken: 'gbt_secret_token_2' }), {
      expect: { url: 'http://127.0.0.1:7411/mcp' },
    });
    expect(res2.replacedPrior).toBe(true);
    expect(res2.backupPath).not.toBeNull();
    expect(statSync(res2.backupPath as string).mode & 0o777).toBe(0o600);
    expect(readFileSync(res2.backupPath as string, 'utf8')).toContain('gbt_secret_token_1');
    expect(readFileSync(cfg(), 'utf8')).toContain('gbt_secret_token_2');
  });

  test('env token mode → no token anywhere, literal {env:} interpolation, mode untouched', () => {
    const res = writeOpencodeMcpEntry(cfg(), remoteInline({ tokenMode: 'env', bearerToken: undefined }));
    const text = readFileSync(cfg(), 'utf8');
    expect(text).toContain('Bearer {env:GBRAIN_REMOTE_TOKEN}');
    expect(text).not.toContain('gbt_secret');
    expect(statSync(cfg()).mode & 0o777).not.toBe(0o600);
    expect(res.priorKind).toBe('absent');
  });

  test('inline mode without a token throws before touching anything', () => {
    expect(() => writeOpencodeMcpEntry(cfg(), remoteInline({ bearerToken: undefined }))).toThrow(/requires a bearerToken/);
    expect(existsSync(cfg())).toBe(false);
  });

  test('parseOpencodeEntryBearer recovers the inline token, never the env interpolation', () => {
    writeOpencodeMcpEntry(cfg(), remoteInline());
    expect(parseOpencodeEntryBearer(cfg(), 'gbrain', 'http://127.0.0.1:7411/mcp')).toBe('gbt_secret_token_1');
    expect(parseOpencodeEntryBearer(cfg(), 'gbrain', 'http://other:1/mcp')).toBeNull();
    const envCfg = join(dir, 'env.json');
    writeOpencodeMcpEntry(envCfg, remoteInline({ tokenMode: 'env', bearerToken: undefined }));
    expect(parseOpencodeEntryBearer(envCfg, 'gbrain')).toBeNull();
    expect(parseOpencodeEntryBearer(join(dir, 'absent.json'), 'gbrain')).toBeNull();
  });
});

describe('unique backups (overlapping-run clobber guard)', () => {
  test('each write takes a UNIQUE .bak-<hex> snapshot — two runs can never clobber each other\'s backup', () => {
    writeOpencodeMcpEntry(cfg(), remoteInline());
    const r1 = writeOpencodeMcpEntry(cfg(), remoteInline({ bearerToken: 'gbt_secret_token_2' }), {
      expect: { url: 'http://127.0.0.1:7411/mcp' },
    });
    const r2 = writeOpencodeMcpEntry(cfg(), remoteInline({ bearerToken: 'gbt_secret_token_3' }), {
      expect: { url: 'http://127.0.0.1:7411/mcp' },
    });
    expect(r1.backupPath).not.toBeNull();
    expect(r2.backupPath).not.toBeNull();
    expect(r1.backupPath).not.toBe(r2.backupPath);
    expect(r1.backupPath as string).toMatch(/\.bak-[0-9a-f]+$/);
    // BOTH snapshots survive: the fixed-name scheme would have overwritten r1's.
    expect(readFileSync(r1.backupPath as string, 'utf8')).toContain('gbt_secret_token_1');
    expect(readFileSync(r2.backupPath as string, 'utf8')).toContain('gbt_secret_token_2');
  });

  test('writtenText in the result is the exact bytes on disk (rollback compare seam)', () => {
    const r = writeOpencodeMcpEntry(cfg(), remoteInline());
    expect(r.writtenText).toBe(readFileSync(cfg(), 'utf8'));
  });

  test('remove path: backup is 0600 whenever the copied content carries an inline bearer', () => {
    writeOpencodeMcpEntry(cfg(), remoteInline());
    chmodSync(cfg(), 0o644); // hand-loosened source must not propagate to a token-bearing backup
    const r = removeOpencodeMcpEntry(cfg(), 'gbrain', { url: 'http://127.0.0.1:7411/mcp' });
    expect(r.removed).toBe(true);
    expect(r.backupPath).toMatch(/\.bak-[0-9a-f]+$/);
    expect(statSync(r.backupPath as string).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.backupPath as string, 'utf8')).toContain('gbt_secret_token_1');
  });

  test('remove path: env-interpolated (token-free) content does NOT force the backup to 0600', () => {
    writeOpencodeMcpEntry(cfg(), remoteInline({ tokenMode: 'env', bearerToken: undefined }));
    chmodSync(cfg(), 0o644);
    const r = removeOpencodeMcpEntry(cfg(), 'gbrain');
    expect(r.removed).toBe(true);
    expect(statSync(r.backupPath as string).mode & 0o777).not.toBe(0o600);
  });

  test('textCarriesInlineBearer: inline bearer yes, {env:} interpolation no', () => {
    expect(textCarriesInlineBearer('"Authorization": "Bearer gbt_x"')).toBe(true);
    expect(textCarriesInlineBearer('"Authorization": "Bearer {env:GBRAIN_REMOTE_TOKEN}"')).toBe(false);
    expect(textCarriesInlineBearer('{"theme":"dark"}')).toBe(false);
  });
});

describe('sibling-global reconcile (two-filename merge blind spot)', () => {
  test('opencodeGlobalSiblingPath pairs the two global names; non-members are null', () => {
    expect(opencodeGlobalSiblingPath(join(dir, 'opencode.json'))).toBe(join(dir, 'opencode.jsonc'));
    expect(opencodeGlobalSiblingPath(join(dir, 'opencode.jsonc'))).toBe(join(dir, 'opencode.json'));
    expect(opencodeGlobalSiblingPath(join(dir, 'config.json'))).toBeNull();
  });

  test('sibling carrying OUR entry is cleaned (note printed) so exactly one global file owns the name', () => {
    const primary = cfg('opencode.jsonc');
    const sibling = cfg('opencode.json');
    writeFileSync(sibling, '{"mcp":{"gbrain":{"type":"local","command":["gbrain","serve"],"environment":{"GBRAIN_SOURCE":"ws-b"}}}}');
    const r = reconcileOpencodeSiblingGlobal(primary, 'gbrain', { sourceId: 'ws-a' });
    expect(r.removed).toBe(true);
    expect(r.siblingPath).toBe(sibling);
    expect(r.notes.join(' ')).toContain('opencode merges both global filenames');
    const parsed = parseOpencodeConfig(readFileSync(sibling, 'utf8'), sibling);
    expect((parsed.mcp as Record<string, unknown> | undefined)?.gbrain).toBeUndefined();
  });

  test('sibling carrying a FOREIGN entry refuses loudly naming BOTH files', () => {
    const primary = cfg('opencode.jsonc');
    const sibling = cfg('opencode.json');
    const foreign = '{"mcp":{"gbrain":{"type":"local","command":["npx","other"],"environment":{}}}}';
    writeFileSync(sibling, foreign);
    let message = '';
    try {
      reconcileOpencodeSiblingGlobal(primary, 'gbrain', { sourceId: 'ws-a' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('not a gbrain-managed entry');
    expect(message).toContain(sibling);
    expect(message).toContain(primary);
    expect(readFileSync(sibling, 'utf8')).toBe(foreign); // untouched
  });

  test('absent sibling / absent entry / non-pair paths are calm no-ops', () => {
    expect(reconcileOpencodeSiblingGlobal(cfg('opencode.jsonc'), 'gbrain').removed).toBe(false);
    writeFileSync(cfg('opencode.json'), '{"mcp":{}}');
    expect(reconcileOpencodeSiblingGlobal(cfg('opencode.jsonc'), 'gbrain').removed).toBe(false);
    expect(reconcileOpencodeSiblingGlobal(join(dir, 'not-a-pair.json'), 'gbrain').removed).toBe(false);
  });
});

describe('remote-path refusal text is caller-appropriate (url, not GBRAIN_SOURCE)', () => {
  test('ours entry at a DIFFERENT url refuses mentioning the url mismatch and --force', () => {
    writeOpencodeMcpEntry(cfg(), remoteInline({ tokenMode: 'env', bearerToken: undefined, url: 'https://old.example/mcp' }));
    let message = '';
    try {
      writeOpencodeMcpEntry(
        cfg(),
        remoteInline({ tokenMode: 'env', bearerToken: undefined, url: 'https://new.example/mcp' }),
        { expect: { url: 'https://new.example/mcp' } },
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('does not match this endpoint');
    expect(message).toContain('https://new.example/mcp');
    expect(message).toContain('--force');
    expect(message).not.toContain('GBRAIN_SOURCE');
    // With the overwrite confirmation the rotation lands.
    const r = writeOpencodeMcpEntry(
      cfg(),
      remoteInline({ tokenMode: 'env', bearerToken: undefined, url: 'https://new.example/mcp' }),
      { expect: { url: 'https://new.example/mcp' }, allowReplaceOtherSource: true },
    );
    expect(r.priorKind).toBe('ours-other-source');
    expect(r.notes.join(' ')).toContain('url/lane mismatch');
  });
});

describe('remove', () => {
  test('absent file and absent entry are calm no-ops', () => {
    const r1 = removeOpencodeMcpEntry(cfg(), 'gbrain');
    expect(r1.removed).toBe(false);
    writeFileSync(cfg(), '{"mcp":{}}');
    const r2 = removeOpencodeMcpEntry(cfg(), 'gbrain');
    expect(r2.removed).toBe(false);
  });

  test('ours removed; comments and foreign servers survive byte-meaningfully', () => {
    writeFileSync(
      cfg('opencode.jsonc'),
      `{
  // keep me
  "theme": "dark",
  "mcp": {
    "other-server": { "type": "remote", "url": "https://other.example/mcp" },
    "gbrain": { "type": "local", "command": ["gbrain", "serve"], "environment": { "GBRAIN_SOURCE": "ws-a" } }
  }
}
`,
    );
    const res = removeOpencodeMcpEntry(cfg('opencode.jsonc'), 'gbrain', { sourceId: 'ws-a' });
    expect(res.removed).toBe(true);
    const text = readFileSync(cfg('opencode.jsonc'), 'utf8');
    expect(text).toContain('// keep me');
    const parsed = parseOpencodeConfig(text, cfg('opencode.jsonc'));
    const mcp = parsed.mcp as Record<string, unknown>;
    expect(mcp.gbrain).toBeUndefined();
    expect((mcp['other-server'] as Record<string, unknown>).url).toBe('https://other.example/mcp');
  });

  test('foreign entry under our name → refuse to remove', () => {
    writeFileSync(cfg(), '{"mcp":{"gbrain":{"type":"local","command":["npx","other"],"environment":{}}}}');
    expect(() => removeOpencodeMcpEntry(cfg(), 'gbrain')).toThrow(/refusing to remove/);
    expect(readFileSync(cfg(), 'utf8')).toContain('npx');
  });

  test('skipOtherSource: a DIFFERENT workspace\'s entry is left in place with a note (uninstall-sweep shape)', () => {
    const before = '{"mcp":{"gbrain":{"type":"local","command":["gbrain","serve"],"environment":{"GBRAIN_SOURCE":"ws-b"}}}}';
    writeFileSync(cfg(), before);
    const r = removeOpencodeMcpEntry(cfg(), 'gbrain', { sourceId: 'ws-a' }, { skipOtherSource: true });
    expect(r.removed).toBe(false);
    expect(r.notes.join(' ')).toMatch(/DIFFERENT gbrain workspace.*left in place/);
    expect(readFileSync(cfg(), 'utf8')).toBe(before);
    // Without the flag the pre-existing behavior holds: removed with a note.
    const r2 = removeOpencodeMcpEntry(cfg(), 'gbrain', { sourceId: 'ws-a' });
    expect(r2.removed).toBe(true);
    expect(r2.notes.join(' ')).toContain('different workspace');
  });
});

describe('misc', () => {
  test('entry names are simple keys only', () => {
    expect(() => writeOpencodeMcpEntry(cfg(), localEntry({ name: 'bad name!' }))).toThrow(/simpler --name/);
  });

  test('snippet is valid JSON carrying the exact entry (paste-by-hand path)', () => {
    const snippet = opencodeEntrySnippet(localEntry());
    const parsed = JSON.parse(snippet) as { mcp: Record<string, { type: string }> };
    expect(parsed.mcp.gbrain.type).toBe('local');
  });

  test('snippet NEVER embeds an inline bearer — placeholder only (error paths render the snippet)', () => {
    const snippet = opencodeEntrySnippet(remoteInline());
    expect(snippet).not.toContain('gbt_secret_token_1');
    expect(snippet).toContain('Bearer <paste-token-here>');
    // The write path is unaffected: the real token still lands in the file.
    writeOpencodeMcpEntry(cfg(), remoteInline());
    expect(readFileSync(cfg(), 'utf8')).toContain('gbt_secret_token_1');
  });

  test('parse-refusal error text carries the placeholder snippet, not the token', () => {
    writeFileSync(cfg(), '{"mcp": {{{');
    let message = '';
    try {
      writeOpencodeMcpEntry(cfg(), remoteInline());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/does not parse as JSONC/);
    expect(message).toContain('<paste-token-here>');
    expect(message).not.toContain('gbt_secret_token_1');
  });
});
