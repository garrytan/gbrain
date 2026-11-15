/**
 * #8543: which thin-client `gbrain serve` argument lists start the stdio
 * bridge. The argv gbrain's own plugin manifests register must bridge (T20),
 * and a refused form's fix keeps its flags, so it is never "fixed" into a
 * bare serve, which on a thin client is the bridge.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OperationError } from '../src/core/ops/contract.ts';
import { parseBridgeServeArgs, serveThinClientRefusal } from '../src/mcp/remote-bridge-args.ts';

const ROOT = join(import.meta.dir, '..');
const MANIFESTS = ['.claude-plugin/plugin.json', '.codex-plugin/mcp.json',
  'plugin-variants/gbrain-coding/.claude-plugin/plugin.json', 'plugin-variants/gbrain-coding/.codex-plugin/mcp.json',
  'plugin-variants/gbrain-daily/.claude-plugin/plugin.json', 'plugin-variants/gbrain-daily/.codex-plugin/mcp.json'];

function serveArgv(node: unknown): string[] | null {
  if (Array.isArray(node) && node.every(x => typeof x === 'string') && node.includes('serve')) return node as string[];
  if (node && typeof node === 'object') for (const v of Object.values(node)) { const hit = serveArgv(v); if (hit) return hit; }
  return null;
}

describe('parseBridgeServeArgs', () => {
  for (const file of MANIFESTS) {
    test(`the argv registered by ${file} starts the bridge`, () => {
      const argv = serveArgv(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
      expect(argv).not.toBeNull();
      const parsed = parseBridgeServeArgs(argv!.slice(argv!.indexOf('serve') + 1));
      expect(parsed.bridge).toBe(true);
    });
  }

  test('bare serve, both value forms and --source-guard bridge; a repeat takes the narrowest', () => {
    expect(parseBridgeServeArgs([])).toEqual({ bridge: true, surface: null, advertise: null, sourceGuard: false });
    expect(parseBridgeServeArgs(['--surface', 'full', '--surface=starter', '--advertise=verbs', '--source-guard']))
      .toEqual({ bridge: true, surface: 'starter', advertise: 'verbs', sourceGuard: true });
  });

  test('a bad surface value is invalid_params, not a host refusal', () => {
    for (const args of [['--surface', 'Starter'], ['--advertise'], ['--surface=']]) {
      let caught: unknown;
      try { parseBridgeServeArgs(args); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(OperationError);
      expect((caught as OperationError).code).toBe('invalid_params');
    }
  });

  test('host-only flags are refused with their flags kept in the fix, unsafe values masked', () => {
    const parsed = parseBridgeServeArgs(['--http', '--port', '3131', '--bind', 'bad host;rm']);
    expect(parsed).toEqual({ bridge: false, refused: ['--http', '--port', '3131', '--bind', 'bad host;rm'] });
    const refusal = serveThinClientRefusal((parsed as { refused: string[] }).refused, 'http://127.0.0.1:1/mcp');
    expect(refusal.code).toBe('requires_local_engine');
    const argv = (refusal as unknown as { fix?: { argv?: string[] } }).fix?.argv ?? [];
    expect(argv).toEqual(['gbrain', 'serve', '--http', '--port', '3131', '--bind', '<value>']);
  });

  test('--access never suggests widening: its fix registers a narrow read-only client', () => {
    const refusal = serveThinClientRefusal(['--access', 'read-only'], 'http://127.0.0.1:1/mcp');
    const argv = (refusal as unknown as { fix: { argv: string[] } }).fix.argv;
    expect(argv.slice(argv.indexOf('--scopes'))).toEqual(['--scopes', 'read']);
    expect(refusal.message + refusal.suggestion).not.toMatch(/\bwrite\b|\badmin\b/);
  });
});
