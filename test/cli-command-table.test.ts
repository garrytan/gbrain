/**
 * Refactor wave 1 W4 (cli): the command table contract (AR5 / AR8 / EO5 / EO13).
 *
 * Protects: src/cli/command-table.ts is the single source of CLI-only
 * dispatch metadata. Every record loads its module through
 * `() => import('<string literal>')` (bun --compile bundles it; a computed
 * specifier would drop the command from the binary), names a module that
 * exists and exports run(), declares the phase and thin-client mode the
 * dispatcher actually implements (read from the flattened pipeline by
 * test/helpers/cli-dispatch-extract.ts, the same shape the W0 golden pins),
 * and the table module loads no command module at import time (cold start).
 * The alias collision check runs over the derived CLI_ONLY set.
 * Fails when: a record uses a computed or non-arrow load, points at a missing
 * module, drifts from the dispatcher's phase / thin-client mode, a module file
 * has no record, the table grows a runtime import, or an op alias shadows a
 * table command without the boot-time collision error.
 * Why new: the switch made literal imports and phase structural; the table
 * makes them data. Seam: none (reads source text and the side-effect-free table).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import {
  CLI_COMMANDS,
  CLI_ONLY,
  THIN_CLIENT_REFUSED_COMMANDS,
  findCliCommand,
} from '../src/cli/command-table.ts';
import { buildCliAliases } from '../src/cli.ts';
import type { Operation } from '../src/core/operations.ts';
import { COMMAND_TABLE_PATH, parseSource, readCommandModule, readTableRecords } from '../scripts/lib/cli-pipeline.ts';
import { extractCliDispatch } from './helpers/cli-dispatch-extract.ts';

const ROOT = join(import.meta.dir, '..');

describe('CLI command table', () => {
  const astRecords = readTableRecords(ROOT);

  test('one record per CLI_ONLY command, in the runtime table order', () => {
    expect(astRecords.map((r) => r.name)).toEqual(CLI_COMMANDS.map((r) => r.name));
    expect(new Set(astRecords.map((r) => r.name)).size).toBe(astRecords.length);
    expect([...CLI_ONLY]).toEqual(CLI_COMMANDS.map((r) => r.name));
    for (const r of CLI_COMMANDS) expect(findCliCommand(r.name)).toBe(r);
  });

  test("every load is () => import('<string literal>') naming an existing module (EO13 / AR8)", () => {
    const bad = astRecords.filter((r) => r.loadSpecifier === null).map((r) => r.name);
    expect(bad, `records whose load is not an arrow returning import('<literal>'): ${bad.join(', ')}`).toEqual([]);
    for (const r of astRecords) {
      const target = join(ROOT, 'src/cli', r.loadSpecifier!);
      expect(existsSync(target), `${r.name}: ${r.loadSpecifier} does not exist`).toBe(true);
    }
  });

  test('table-dispatched records name a src/cli/commands module exporting run(); deferred records name the persistence delegate', () => {
    for (const record of CLI_COMMANDS) {
      const spec = astRecords.find((r) => r.name === record.name)!.loadSpecifier!;
      if (record.dispatchedBy === 'deferred-persistence') {
        expect(spec).toBe('../commands/persistence-delegate.ts');
        continue;
      }
      expect(spec).toBe(`./commands/${record.name}.ts`);
      const mod = readCommandModule(ROOT, spec);
      expect(mod, `${record.name}: module missing`).not.toBeNull();
      const params = mod!.run.parameters.map((p) => p.name.getText());
      if (record.phase === 'post-connect') expect(params.slice(0, 2)).toEqual(['engine', 'args']);
      else expect(params[0]).toBe('args');
    }
  });

  test('every src/cli/commands module has exactly one record', () => {
    const files = readdirSync(join(ROOT, 'src/cli/commands')).filter((f) => f.endsWith('.ts')).sort();
    const named = astRecords.map((r) => r.loadSpecifier!).filter((s) => s.startsWith('./commands/')).map((s) => s.slice('./commands/'.length)).sort();
    expect(files).toEqual(named);
  });

  test("record phase and thin-client mode equal what the dispatcher implements (EO5 / T-G6)", () => {
    const shape = extractCliDispatch();
    for (const record of CLI_COMMANDS) {
      const actual = shape.commands[record.name];
      expect(actual, `${record.name}: not found in the dispatch shape`).toBeDefined();
      expect({ name: record.name, phase: record.phase, thinClient: record.thinClient })
        .toEqual({ name: record.name, phase: actual!.phase as typeof record.phase, thinClient: actual!.thinClient });
    }
  });

  test('thin-client modes outside the refused set are exactly the guard literals plus jobs', () => {
    const outside = CLI_COMMANDS.filter((r) => r.thinClient !== 'none' && !THIN_CLIENT_REFUSED_COMMANDS.has(r.name)).map((r) => r.name).sort();
    const shape = extractCliDispatch();
    expect(outside).toEqual([...shape.thinClientGuard.members, 'jobs'].sort());
  });

  test("D3: every curated help is () => import('./help/<name>.ts') naming an existing module that exports help", async () => {
    const withHelp = astRecords.filter((r) => r.helpSpecifier !== undefined);
    expect(withHelp.map((r) => r.name)).toEqual(CLI_COMMANDS.filter((r) => r.help).map((r) => r.name));
    for (const r of withHelp) {
      expect(r.helpSpecifier, `${r.name}: help is not an arrow returning import('<literal>')`).toBe(`./help/${r.name}.ts`);
      expect(existsSync(join(ROOT, 'src/cli', r.helpSpecifier!)), `${r.name}: ${r.helpSpecifier} does not exist`).toBe(true);
      expect((await findCliCommand(r.name)!.help!()).help.summary.length).toBeGreaterThan(0);
    }
  });

  test('D3: every src/cli/help spec module has a record; the renderer and validator import none of them (cold start)', () => {
    const shared = new Set(['render.ts', 'validate.ts']);
    const files = readdirSync(join(ROOT, 'src/cli/help')).filter((f) => f.endsWith('.ts') && !shared.has(f)).sort();
    expect(files).toEqual(astRecords.filter((r) => r.helpSpecifier).map((r) => r.helpSpecifier!.slice('./help/'.length)).sort());
    for (const f of shared) {
      const imports = parseSource(ROOT, `src/cli/help/${f}`).statements.filter(ts.isImportDeclaration)
        .map((st) => (st.moduleSpecifier as ts.StringLiteral).text);
      expect(imports.filter((spec) => files.some((h) => spec === `./${h}`))).toEqual([]);
    }
  });

  test('the table module loads no command module at import time (cold start)', () => {
    const sf = parseSource(ROOT, COMMAND_TABLE_PATH);
    const runtimeImports = sf.statements.filter((st) => ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly);
    expect(runtimeImports.map((st) => st.getText())).toEqual([]);
  });

  test('the alias collision check runs over the derived table', () => {
    const fakeOp = (name: string, aliases: string[]) => ({ name, cliHints: { name, aliases } }) as unknown as Operation;
    for (const record of CLI_COMMANDS) {
      expect(() => buildCliAliases([fakeOp('synthetic_example_op', [record.name])], new Map(), CLI_ONLY))
        .toThrow(`CLI alias collision: '${record.name}'`);
    }
    expect(buildCliAliases([fakeOp('synthetic_example_op', ['synthetic-example-alias'])], new Map(), CLI_ONLY).get('synthetic-example-alias')?.name)
      .toBe('synthetic_example_op');
  });
});
