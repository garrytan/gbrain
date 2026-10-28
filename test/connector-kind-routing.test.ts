import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONNECTOR_KINDS_SQL, CONNECTOR_SOURCE_KINDS, connectorDirKey, isConnectorSourceKind } from '../src/core/persistence/connector-kinds.ts';

const ROOT = join(import.meta.dir, '..');
const KINDS_FILE = 'src/core/persistence/connector-kinds.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const KIND = String.raw`'(?:google|github)'`;
// A list of two or more literal connector kinds (SQL IN list or array), or a kind test chained over two literal kinds.
const FORBIDDEN: Array<[string, RegExp]> = [
  ['literal kind list', new RegExp(`[\\[(]\\s*${KIND}\\s*,\\s*${KIND}`)],
  ['chained kind test', new RegExp(`kind\\s*[!=]==\\s*${KIND}\\s*(?:&&|\\|\\|)\\s*[\\w.?]*kind\\s*[!=]==\\s*${KIND}`)],
];

describe('connector kind routing', () => {
  test('no source file outside connector-kinds.ts lists connector kinds literally', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (rel === KINDS_FILE) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        for (const [what, pattern] of FORBIDDEN) if (pattern.test(line)) offenders.push(`${rel}:${index + 1} ${what}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('the lint catches the shapes it forbids', () => {
    const hits = (line: string) => FORBIDDEN.some(([, pattern]) => pattern.test(line));
    expect(hits("WHERE config->>'kind' IN ('google','github')")).toBe(true);
    expect(hits("if (!['google', 'github'].includes(kind))")).toBe(true);
    expect(hits("if (config.kind !== 'google' && config.kind !== 'github') continue;")).toBe(true);
    expect(hits("return config.kind === 'google' || config.kind === 'github';")).toBe(true);
    expect(hits("if (c.kind !== 'google') continue;")).toBe(false);
  });

  test('the SQL list, the guard and the directory keys cover exactly the declared kinds', () => {
    expect(CONNECTOR_KINDS_SQL).toBe(CONNECTOR_SOURCE_KINDS.map(kind => `'${kind}'`).join(','));
    for (const kind of CONNECTOR_SOURCE_KINDS) {
      expect(isConnectorSourceKind(kind)).toBe(true);
      expect(connectorDirKey(kind)).toMatch(/^[a-z]+_dir$/);
    }
    expect(isConnectorSourceKind('local')).toBe(false);
    expect(isConnectorSourceKind(undefined)).toBe(false);
    expect(connectorDirKey('google')).toBe('g_dir');
    expect(connectorDirKey('github')).toBe('gh_dir');
  });
});
