/**
 * codex-toml.test.ts — the managed marker-block writer for Codex's
 * config.toml (#4043, fired CX2-17 revisit). Pins the safety invariants:
 * foreign-server refusal via real TOML parse, byte-preservation outside the
 * block, re-anchor-to-EOF rewrites, marker-anomaly refusals, CRLF/no-eol
 * repair, post-render key assertion, and 0600 secrets hygiene.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectForeignCodexServer,
  removeCodexHttpServerBlock,
  renderCodexHttpServerBlock,
  tomlString,
  writeCodexHttpServerBlock,
} from '../src/core/bootstrap/codex-toml.ts';
import { CODEX_TOML_BLOCK_BEGIN, CODEX_TOML_BLOCK_END } from '../src/core/bootstrap/host-specs.ts';

const BLOCK = { name: 'gbrain', url: 'http://127.0.0.1:3131/mcp', bearerToken: 'gbrain_deadbeef' };

function tmpConfig(): string {
  return join(mkdtempSync(join(tmpdir(), 'gb-codex-toml-')), 'config.toml');
}

describe('writeCodexHttpServerBlock', () => {
  test('fresh file: created 0600 with exactly the block, KEY = "value" spacing', () => {
    const path = tmpConfig();
    const res = writeCodexHttpServerBlock(path, BLOCK);
    expect(res.replacedPrior).toBe(false);
    expect(res.backupPath).toBeNull();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(CODEX_TOML_BLOCK_BEGIN);
    expect(text).toContain('[mcp_servers.gbrain]');
    expect(text).toContain('url = "http://127.0.0.1:3131/mcp"');
    expect(text).toContain('bearer_token = "gbrain_deadbeef"');
    expect(text).toContain(CODEX_TOML_BLOCK_END);
    expect(text.endsWith('\n')).toBe(true);
  });

  test('foreign content survives byte-for-byte; block appended at EOF', () => {
    const path = tmpConfig();
    const foreign = '# my codex config\nmodel = "o5"\n\n[mcp_servers.other]\ncommand = "npx"\n';
    writeFileSync(path, foreign);
    writeCodexHttpServerBlock(path, BLOCK);
    const text = readFileSync(path, 'utf8');
    expect(text.startsWith('# my codex config\nmodel = "o5"\n\n[mcp_servers.other]\ncommand = "npx"\n')).toBe(true);
    expect(text.indexOf(CODEX_TOML_BLOCK_BEGIN)).toBeGreaterThan(foreign.indexOf('[mcp_servers.other]'));
  });

  test('idempotent re-run: exactly one block; token rotates in place', () => {
    const path = tmpConfig();
    writeCodexHttpServerBlock(path, BLOCK);
    const res = writeCodexHttpServerBlock(path, { ...BLOCK, bearerToken: 'gbrain_rotated' });
    expect(res.replacedPrior).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text.split(CODEX_TOML_BLOCK_BEGIN).length - 1).toBe(1);
    expect(text).toContain('gbrain_rotated');
    expect(text).not.toContain('gbrain_deadbeef');
  });

  test('re-anchor: user content added AFTER the block moves above it on rewrite', () => {
    const path = tmpConfig();
    writeCodexHttpServerBlock(path, BLOCK);
    // a later legitimate write appends another server after our block
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n[mcp_servers.late]\ncommand = "bunx"\n`);
    writeCodexHttpServerBlock(path, { ...BLOCK, bearerToken: 'gbrain_v2' });
    const text = readFileSync(path, 'utf8');
    expect(text.indexOf('[mcp_servers.late]')).toBeLessThan(text.indexOf(CODEX_TOML_BLOCK_BEGIN));
    // trailing keys were NOT re-parented into our table (post-render assert)
    expect(text.trimEnd().endsWith(CODEX_TOML_BLOCK_END)).toBe(true);
  });

  test('foreign [mcp_servers.gbrain] outside our block refused — any TOML spelling', () => {
    for (const spelling of [
      '[mcp_servers.gbrain]\ncommand = "npx"\n',
      '[mcp_servers]\ngbrain = { command = "npx" }\n',
      '[mcp_servers."gbrain"]\ncommand = "npx"\n',
      '[mcp_servers]\ngbrain.command = "npx"\n',
    ]) {
      const path = tmpConfig();
      writeFileSync(path, spelling);
      expect(() => writeCodexHttpServerBlock(path, BLOCK)).toThrow(/already defined/);
      expect(readFileSync(path, 'utf8')).toBe(spelling); // untouched
    }
  });

  test('unparseable config outside the block refused, file untouched', () => {
    const path = tmpConfig();
    const broken = '[mcp_servers\nnot toml';
    writeFileSync(path, broken);
    expect(() => writeCodexHttpServerBlock(path, BLOCK)).toThrow(/does not parse as TOML/);
    expect(readFileSync(path, 'utf8')).toBe(broken);
  });

  test('damaged markers refused (duplicate begin / missing end / out of order)', () => {
    for (const text of [
      `${CODEX_TOML_BLOCK_BEGIN}\n${CODEX_TOML_BLOCK_BEGIN}\n${CODEX_TOML_BLOCK_END}\n`,
      `${CODEX_TOML_BLOCK_BEGIN}\n[mcp_servers.gbrain]\nurl = "x"\n`,
      `${CODEX_TOML_BLOCK_END}\n${CODEX_TOML_BLOCK_BEGIN}\n`,
    ]) {
      const path = tmpConfig();
      writeFileSync(path, text);
      expect(() => writeCodexHttpServerBlock(path, BLOCK)).toThrow(/damaged/);
      expect(readFileSync(path, 'utf8')).toBe(text);
    }
  });

  test('no trailing newline on existing content is repaired (no marker gluing)', () => {
    const path = tmpConfig();
    writeFileSync(path, 'model = "o5"'); // no trailing \n
    writeCodexHttpServerBlock(path, BLOCK);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(`model = "o5"\n`);
    // run 2 must still find exactly one pair (idempotent, not duplicate-append)
    writeCodexHttpServerBlock(path, BLOCK);
    expect(readFileSync(path, 'utf8').split(CODEX_TOML_BLOCK_BEGIN).length - 1).toBe(1);
  });

  test('CRLF config: scan works and dominant EOL is preserved', () => {
    const path = tmpConfig();
    writeFileSync(path, 'model = "o5"\r\n');
    writeCodexHttpServerBlock(path, BLOCK);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('\r\n');
    expect(text.replace(/\r\n/g, '\n')).toContain(`${CODEX_TOML_BLOCK_BEGIN}\n[mcp_servers.gbrain]`);
    // idempotent under CRLF too
    writeCodexHttpServerBlock(path, BLOCK);
    expect(readFileSync(path, 'utf8').split(CODEX_TOML_BLOCK_BEGIN).length - 1).toBe(1);
  });

  test('pre-existing group-readable file tightened to 0600 with a note; .bak is 0600', () => {
    const path = tmpConfig();
    writeFileSync(path, 'model = "o5"\n', { mode: 0o644 });
    const res = writeCodexHttpServerBlock(path, BLOCK);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(res.notes.join(' ')).toMatch(/tightened to 0600/);
    expect(res.backupPath).not.toBeNull();
    expect(statSync(res.backupPath!).mode & 0o777).toBe(0o600);
  });

  test('bad server names refused before any I/O', () => {
    const path = tmpConfig();
    expect(() => writeCodexHttpServerBlock(path, { ...BLOCK, name: 'my server' })).toThrow(/bare TOML key/);
    expect(existsSync(path)).toBe(false);
  });
});

describe('removeCodexHttpServerBlock', () => {
  test('removes exactly the block; foreign content byte-identical; .bak 0600', () => {
    const path = tmpConfig();
    const foreign = '# keep me\nmodel = "o5"\n\n[mcp_servers.other]\ncommand = "npx"\n';
    writeFileSync(path, foreign);
    writeCodexHttpServerBlock(path, BLOCK);
    const res = removeCodexHttpServerBlock(path, 'gbrain');
    expect(res.removed).toBe(true);
    expect(statSync(res.backupPath!).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe(foreign);
  });

  test('block-only file removes to empty; absent file / absent block are no-ops', () => {
    const path = tmpConfig();
    writeCodexHttpServerBlock(path, BLOCK);
    expect(removeCodexHttpServerBlock(path, 'gbrain').removed).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(removeCodexHttpServerBlock(path, 'gbrain').removed).toBe(false);
    expect(removeCodexHttpServerBlock(join(tmpdir(), 'nope', 'config.toml'), 'gbrain').removed).toBe(false);
  });

  test('damaged markers refuse removal, file untouched', () => {
    const path = tmpConfig();
    const text = `${CODEX_TOML_BLOCK_BEGIN}\nurl = "x"\n`; // begin without end
    writeFileSync(path, text);
    expect(() => removeCodexHttpServerBlock(path, 'gbrain')).toThrow(/damaged/);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });
});

describe('detectForeignCodexServer', () => {
  test('sees through every spelling; ignores our own managed block', () => {
    expect(detectForeignCodexServer('[mcp_servers.gbrain]\ncommand = "npx"\n', 'gbrain')).toBe(true);
    expect(detectForeignCodexServer('[mcp_servers]\ngbrain = { command = "npx" }\n', 'gbrain')).toBe(true);
    expect(detectForeignCodexServer('[mcp_servers.other]\ncommand = "npx"\n', 'gbrain')).toBe(false);
    expect(detectForeignCodexServer('', 'gbrain')).toBe(false);
    const ours = [
      CODEX_TOML_BLOCK_BEGIN,
      '[mcp_servers.gbrain]',
      'url = "http://127.0.0.1:3131/mcp"',
      'bearer_token = "t"',
      CODEX_TOML_BLOCK_END,
      '',
    ].join('\n');
    expect(detectForeignCodexServer(ours, 'gbrain')).toBe(false);
  });
});

describe('tomlString', () => {
  test('escapes quotes and backslashes; refuses control chars', () => {
    expect(tomlString('plain')).toBe('"plain"');
    expect(tomlString('a"b')).toBe('"a\\"b"');
    expect(tomlString('a\\b')).toBe('"a\\\\b"');
    expect(() => tomlString('a\nb')).toThrow(/control characters/);
  });
});

describe('renderCodexHttpServerBlock', () => {
  const parseToml = (t: string): Record<string, any> =>
    (Bun as unknown as { TOML: { parse(x: string): unknown } }).TOML.parse(t) as Record<string, any>;

  test('parses back to exactly {bearer_token, url}; contains NO marker lines', () => {
    const text = renderCodexHttpServerBlock(BLOCK);
    expect(text).not.toContain(CODEX_TOML_BLOCK_BEGIN);
    expect(text).not.toContain(CODEX_TOML_BLOCK_END);
    // markers are full-line comments — a marker-free snippet has no comment lines at all
    for (const line of text.split('\n')) expect(line.trimStart().startsWith('#')).toBe(false);
    const ours = parseToml(text).mcp_servers?.[BLOCK.name];
    expect(Object.keys(ours as object).sort()).toEqual(['bearer_token', 'url']);
    expect(ours.url).toBe(BLOCK.url);
    expect(ours.bearer_token).toBe(BLOCK.bearerToken);
  });

  test('escaped values round-trip through the TOML parser', () => {
    const gnarly = { name: 'gbrain', url: 'http://127.0.0.1:3131/mcp', bearerToken: 'to"ken\\v2' };
    const ours = parseToml(renderCodexHttpServerBlock(gnarly)).mcp_servers?.gbrain;
    expect(ours.bearer_token).toBe('to"ken\\v2');
    expect(Object.keys(ours as object).sort()).toEqual(['bearer_token', 'url']);
  });

  test('refuses a non-bare-key name (same assertion as the writer)', () => {
    expect(() => renderCodexHttpServerBlock({ ...BLOCK, name: 'bad name' })).toThrow(/bare TOML key/);
  });

  test('refuses control characters in values (writer parity)', () => {
    expect(() => renderCodexHttpServerBlock({ ...BLOCK, bearerToken: 'a\nb' })).toThrow(/control characters/);
  });

  test('pasted snippet reads as a FOREIGN table — the managed writer refuses to double-define, never strips it', () => {
    const path = tmpConfig();
    writeFileSync(path, `${renderCodexHttpServerBlock(BLOCK)}\n`);
    expect(() => writeCodexHttpServerBlock(path, BLOCK)).toThrow(/already defined/);
  });
});
