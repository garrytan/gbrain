/**
 * hermes-yaml.ts: single-entry text edits of a Hermes config.yaml.
 *
 * Authoring gate:
 *  1. Protects: `gbrain setup hermes` adds and removes exactly its own
 *     mcp_servers entry and hook items without touching any other byte,
 *     comment or key, and refuses a file it cannot parse or an entry it cannot
 *     locate instead of rewriting it.
 *  2. Fails on: a dumper round-trip (comments lost), a removal that takes a
 *     neighbour, a created container left behind, an unparseable file rewritten.
 *  3. Pure file transforms against temp files; no network, no Hermes.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendHermesYamlEntry, appendHermesYamlText, hermesConfigGuard, HermesConfigConflict, readHermesYaml, removeHermesYamlEntry, removeHermesYamlText,
} from '../src/core/bootstrap/hermes-yaml.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function file(text?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-hermes-yaml-'));
  dirs.push(dir);
  const p = join(dir, 'config.yaml');
  if (text !== undefined) writeFileSync(p, text);
  return p;
}
const entry = { key: 'gbrain', value: { command: '/bin/gbrain', args: ['serve', '--surface', 'full'], env: { GBRAIN_HOME: '/h' } } };
const hookItem = { command: 'env GBRAIN_HOOK_LANE=setup /bin/gbrain hook user-prompt --harness hermes', timeout: 10 };
const isHook = (i: unknown) => (i as { command?: string })?.command === hookItem.command;

describe('hermes-yaml mcp_servers entry', () => {
  const foreign = [
    '# my hermes profile', 'model:', '  default: some-model  # keep', '',
    'mcp_servers:', '  other:', '    command: /bin/true', '    args: [a, b]', '',
    'hooks_auto_accept: false', '',
  ].join('\n');

  test('append then remove restores the file byte for byte, comments and unrelated servers untouched', () => {
    const p = file(foreign);
    appendHermesYamlEntry(p, ['mcp_servers'], entry, 'gbrain setup (gbrain)');
    expect(readHermesYaml(p, ['mcp_servers', 'gbrain'])).toEqual(entry.value);
    expect(readHermesYaml(p, ['mcp_servers', 'other'])).toEqual({ command: '/bin/true', args: ['a', 'b'] });
    expect(readFileSync(p, 'utf8').startsWith(foreign.slice(0, foreign.indexOf('hooks_auto_accept')))).toBe(false);
    expect(removeHermesYamlEntry(p, ['mcp_servers'], { key: 'gbrain' })).toBe('removed');
    expect(readFileSync(p, 'utf8')).toBe(foreign);
  });

  test('creates mcp_servers when absent and removes the created header again', () => {
    const base = '# only a comment\nmodel: x\n';
    const p = file(base);
    appendHermesYamlEntry(p, ['mcp_servers'], entry, 'gbrain setup (gbrain)');
    expect(readHermesYaml(p, ['mcp_servers', 'gbrain'])).toEqual(entry.value);
    expect(removeHermesYamlEntry(p, ['mcp_servers'], { key: 'gbrain' })).toBe('removed');
    expect(readFileSync(p, 'utf8')).toBe(base);
  });

  test('a missing file is created and removing the only entry deletes the content again', () => {
    const p = file();
    appendHermesYamlEntry(p, ['mcp_servers'], entry, 'gbrain setup (gbrain)');
    expect(readHermesYaml(p, ['mcp_servers', 'gbrain'])).toEqual(entry.value);
    expect(removeHermesYamlEntry(p, ['mcp_servers'], { key: 'gbrain' })).toBe('removed');
    expect(readFileSync(p, 'utf8')).toBe('');
  });

  test('an empty flow mapping `mcp_servers: {}` is converted and restored', () => {
    const base = 'model: x\nmcp_servers: {}\nafter: 1\n';
    const p = file(base);
    appendHermesYamlEntry(p, ['mcp_servers'], entry, 'gbrain setup (gbrain)');
    expect(readHermesYaml(p, ['mcp_servers', 'gbrain'])).toEqual(entry.value);
    expect(readHermesYaml(p, ['after'])).toBe(1);
    expect(removeHermesYamlEntry(p, ['mcp_servers'], { key: 'gbrain' })).toBe('removed');
    expect(readFileSync(p, 'utf8')).toBe(base);
  });

  test('dry-run reports removed and writes nothing; absent and unparseable files', () => {
    const p = file(foreign);
    appendHermesYamlEntry(p, ['mcp_servers'], entry, 'x');
    const mid = readFileSync(p, 'utf8');
    expect(removeHermesYamlEntry(p, ['mcp_servers'], { key: 'gbrain' }, { dryRun: true })).toBe('removed');
    expect(readFileSync(p, 'utf8')).toBe(mid);
    expect(removeHermesYamlEntry(p, ['mcp_servers'], { key: 'nope' })).toBe('absent');
    const bad = file('mcp_servers: [unclosed\n');
    expect(() => appendHermesYamlEntry(bad, ['mcp_servers'], entry, 'x')).toThrow('never rewrites a file it cannot parse');
    expect(readFileSync(bad, 'utf8')).toBe('mcp_servers: [unclosed\n');
    const notMap = file('- a\n- b\n');
    expect(() => readHermesYaml(notMap, ['mcp_servers'])).toThrow('not a YAML mapping');
  });

  test('a non-empty flow mapping is refused on write and unlocatable on remove, file untouched', () => {
    const flow = 'mcp_servers: {gbrain: {command: /bin/gbrain}, other: {command: /bin/true}}\n';
    const p = file(flow);
    expect(() => appendHermesYamlEntry(p, ['mcp_servers'], { key: 'x', value: { command: '/y' } }, 'x')).toThrow('cannot edit safely');
    expect(readFileSync(p, 'utf8')).toBe(flow);
    expect(removeHermesYamlEntry(p, ['mcp_servers'], { key: 'gbrain' })).toBe('unlocatable');
    expect(readFileSync(p, 'utf8')).toBe(flow);
  });

  test('CRLF files keep their line endings', () => {
    const base = 'model: x\r\nmcp_servers:\r\n  other:\r\n    command: /bin/true\r\n';
    const p = file(base);
    appendHermesYamlEntry(p, ['mcp_servers'], entry, 'x');
    expect(readFileSync(p, 'utf8')).not.toMatch(/[^\r]\n/);
    expect(removeHermesYamlEntry(p, ['mcp_servers'], { key: 'gbrain' })).toBe('removed');
    expect(readFileSync(p, 'utf8')).toBe(base);
  });
});

describe('hermes-yaml hook sequence items', () => {
  test('appends one item under hooks.pre_llm_call beside a foreign item and removes only it', () => {
    const base = ['hooks:', '  pre_llm_call:', '    - command: /usr/local/bin/mine', '      timeout: 5', '  on_session_finalize:', '    - command: /x', 'model: y', ''].join('\n');
    const p = file(base);
    appendHermesYamlEntry(p, ['hooks', 'pre_llm_call'], { item: hookItem }, 'gbrain setup (gbrain)');
    expect(readHermesYaml(p, ['hooks', 'pre_llm_call'])).toEqual([{ command: '/usr/local/bin/mine', timeout: 5 }, hookItem]);
    expect(readHermesYaml(p, ['hooks', 'on_session_finalize'])).toEqual([{ command: '/x' }]);
    expect(removeHermesYamlEntry(p, ['hooks', 'pre_llm_call'], { match: isHook })).toBe('removed');
    expect(readFileSync(p, 'utf8')).toBe(base);
  });

  test('creates hooks and the event list when missing, and removes them when emptied', () => {
    const base = 'model: y\n';
    const p = file(base);
    appendHermesYamlEntry(p, ['hooks', 'pre_llm_call'], { item: hookItem }, 'gbrain setup (gbrain)');
    expect(readHermesYaml(p, ['hooks', 'pre_llm_call'])).toEqual([hookItem]);
    expect(removeHermesYamlEntry(p, ['hooks', 'pre_llm_call'], { match: isHook })).toBe('removed');
    expect(readFileSync(p, 'utf8')).toBe(base);
  });

  test('items written at the key indent (`- x` under `event:` with no extra indent) are located', () => {
    const base = ['hooks:', '  pre_llm_call:', '  - command: /a', '  - command: /b', ''].join('\n');
    const p = file(base);
    appendHermesYamlEntry(p, ['hooks', 'pre_llm_call'], { item: hookItem }, 'x');
    expect((readHermesYaml(p, ['hooks', 'pre_llm_call']) as unknown[]).length).toBe(3);
    expect(removeHermesYamlEntry(p, ['hooks', 'pre_llm_call'], { match: isHook })).toBe('removed');
    expect(readFileSync(p, 'utf8')).toBe(base);
  });

  test('an empty flow sequence `pre_llm_call: []` is converted and restored; a rewritten (re-rendered) item is preserved as unlocatable only when its lines cannot be told apart', () => {
    const base = 'hooks:\n  pre_llm_call: []\n';
    const p = file(base);
    appendHermesYamlEntry(p, ['hooks', 'pre_llm_call'], { item: hookItem }, 'x');
    expect(readHermesYaml(p, ['hooks', 'pre_llm_call'])).toEqual([hookItem]);
    expect(removeHermesYamlEntry(p, ['hooks', 'pre_llm_call'], { match: isHook })).toBe('removed');
    expect(readFileSync(p, 'utf8')).toBe(base);
    const inline = file('hooks:\n  pre_llm_call: [{command: /a}]\n');
    expect(removeHermesYamlEntry(inline, ['hooks', 'pre_llm_call'], { match: (i) => (i as { command: string }).command === '/a' })).toBe('unlocatable');
  });
});

describe('hermes-yaml: null headers are convertible empty containers (review finding 1)', () => {
  const cases: Array<[string, string]> = [
    ['mcp_servers: null', 'model: x\nmcp_servers: null\nhooks_auto_accept: false\n'],
    ['mcp_servers: ~', 'mcp_servers: ~\nmodel: x\n'],
    ['mcp_servers: Null', 'mcp_servers: Null\n'],
  ];
  for (const [name, text] of cases) {
    test(`${name}: append parses, remove restores the original bytes`, () => {
      const p = file(text);
      appendHermesYamlEntry(p, ['mcp_servers'], entry, 'gbrain setup (gbrain)');
      expect(readHermesYaml(p, ['mcp_servers', 'gbrain'])).toEqual(entry.value);
      expect(removeHermesYamlEntry(p, ['mcp_servers'], { key: 'gbrain' })).toBe('removed');
      expect(readFileSync(p, 'utf8')).toBe(text);
    });
  }
  test('hooks: null and hooks.<event>: null (what PyYAML writes for an emptied container) convert and restore', () => {
    for (const text of ['hooks: null\nmodel: x\n', 'hooks:\n  pre_llm_call: null\nmodel: x\n', 'hooks:\n  pre_llm_call: ~\n  on_session_finalize: []\n']) {
      const p = file(text);
      appendHermesYamlEntry(p, ['hooks', 'pre_llm_call'], { item: hookItem }, 'gbrain setup (gbrain)');
      expect((readHermesYaml(p, ['hooks', 'pre_llm_call']) as unknown[]).length).toBe(1);
      expect(removeHermesYamlEntry(p, ['hooks', 'pre_llm_call'], { match: isHook })).toBe('removed');
      expect(readFileSync(p, 'utf8')).toBe(text);
    }
  });
  test('genuinely unsupported shapes (hooks as a list, a non-empty flow map, a commented {}) throw a clear message on the pure form too, before any write', () => {
    expect(() => appendHermesYamlText('c.yaml', 'hooks: [a, b]\n', ['hooks', 'pre_llm_call'], { item: hookItem }, 'x')).toThrow(/cannot edit safely|would change other settings/);
    expect(() => appendHermesYamlText('c.yaml', 'hooks:\n  - a\n  - b\n', ['hooks', 'pre_llm_call'], { item: hookItem }, 'x')).toThrow();
    expect(() => appendHermesYamlText('c.yaml', 'mcp_servers: {a: {command: x}}\n', ['mcp_servers'], entry, 'x')).toThrow(/cannot edit safely/);
    expect(() => appendHermesYamlText('c.yaml', 'mcp_servers: {}  # mine\n', ['mcp_servers'], entry, 'x')).toThrow(/comment setup cannot preserve/);
    expect(() => appendHermesYamlText('c.yaml', 'mcp_servers: &a\n  x: {command: y}\n', ['mcp_servers'], entry, 'x')).toThrow();
  });
  test('the pure forms never touch disk: the same text edits round-trip in memory', () => {
    const text = 'model: x\nmcp_servers: null\n';
    const added = appendHermesYamlText('c.yaml', text, ['mcp_servers'], entry, 'gbrain setup (gbrain)');
    expect(added).not.toBe(text);
    const gone = removeHermesYamlText('c.yaml', added, ['mcp_servers'], { key: 'gbrain' });
    expect(gone).toEqual({ result: 'removed', text });
    expect(removeHermesYamlText('c.yaml', text, ['mcp_servers'], { key: 'gbrain' }).result).toBe('absent');
  });
});

describe('hermes-yaml: byte-exact restore of BOM, final newline and line endings (review findings 6 and 7)', () => {
  const roundTrip = (text: string) => {
    const p = file(text);
    appendHermesYamlEntry(p, ['mcp_servers'], entry, 'gbrain setup (gbrain)');
    expect(readHermesYaml(p, ['mcp_servers', 'gbrain'])).toEqual(entry.value);
    expect(removeHermesYamlEntry(p, ['mcp_servers'], { key: 'gbrain' })).toBe('removed');
    expect(readFileSync(p, 'utf8')).toBe(text);
  };
  test('a UTF-8 BOM is preserved and the entry stays locatable', () => roundTrip('\uFEFFmodel: x\nmcp_servers:\n  other:\n    command: /bin/true\n'));
  test('no trailing newline after the last line is restored exactly', () => {
    roundTrip('mcp_servers:\n  other:\n    command: y');
    roundTrip('model: x');
  });
  test('mixed CRLF/LF line endings come back as they were', () => roundTrip('model: x\r\nmcp_servers:\n  other:\r\n    command: y\n'));
  test('a CRLF file stays CRLF, including the lines setup inserts', () => {
    const p = file('model: x\r\nmcp_servers:\r\n  other:\r\n    command: y\r\n');
    appendHermesYamlEntry(p, ['mcp_servers'], entry, 'gbrain setup (gbrain)');
    const raw = readFileSync(p, 'utf8');
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
  });
  test('an empty file and a file with only a BOM round-trip', () => {
    roundTrip('');
    roundTrip('\uFEFF');
  });
});

describe('hermes-yaml: concurrent-writer guard (review finding 9)', () => {
  test('a write aborts with HermesConfigConflict when the file changed since the guard was taken; nothing is written', () => {
    const p = file('model: x\n');
    const guard = hermesConfigGuard(p);
    writeFileSync(p, 'model: x\nsomething: hermes-wrote-this\n');
    expect(() => appendHermesYamlEntry(p, ['mcp_servers'], entry, 'x', { guard })).toThrow(HermesConfigConflict);
    expect(readFileSync(p, 'utf8')).toBe('model: x\nsomething: hermes-wrote-this\n');
  });
  test('the guard follows our own writes, so a sequence of edits passes; a foreign write in between does not', () => {
    const p = file('model: x\n');
    const guard = hermesConfigGuard(p);
    appendHermesYamlEntry(p, ['mcp_servers'], entry, 'x', { guard });
    appendHermesYamlEntry(p, ['hooks', 'pre_llm_call'], { item: hookItem }, 'x', { guard });
    writeFileSync(p, readFileSync(p, 'utf8') + 'late: 1\n');
    expect(() => removeHermesYamlEntry(p, ['mcp_servers'], { key: 'gbrain' }, { guard })).toThrow(/configuration_conflict/);
    expect(readFileSync(p, 'utf8')).toContain('late: 1');
  });
});
