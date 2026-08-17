/**
 * Unit tests for the test-intent classifier (scripts/classify-tests.ts).
 * classifyFile is pure (path + content in, rows out) so every detector and
 * attribution rule gets a direct fixture — no filesystem needed.
 */
import { describe, test, expect } from 'bun:test';
import { classifyFile } from '../../scripts/classify-tests.ts';

describe('classify-tests detectors', () => {
  test('repo-anchored readFileSync binding attributes the referencing suite', () => {
    const src = [
      "import { readFileSync } from 'node:fs';",
      "const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'doctor.ts'), 'utf-8');",
      "describe('structural pin', () => {",
      "  test('contains marker', () => { expect(SRC).toContain('x'); });",
      "  test('other', () => { expect(SRC).toMatch(/y/); });",
      '});',
      "describe('behavioral', () => {",
      "  test('runs code', () => { expect(1).toBe(1); });",
      '});',
    ].join('\n');
    const res = classifyFile('test/fake.test.ts', src);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].suite).toBe('structural pin');
    expect(res.rows[0].cases).toBe(2);
    expect(res.rows[0].detector).toBe('readFileSync');
    expect(res.unknown).toBe(false);
  });

  test('tmpdir reads are behavioral, not structural', () => {
    const src = [
      "const out = readFileSync(join(tmpdir, 'AGENTS.md'), 'utf-8');",
      "describe('scaffolder output', () => {",
      "  test('emits agents md', () => { expect(out).toContain('gbrain'); });",
      '});',
    ].join('\n');
    expect(classifyFile('test/fake.test.ts', src).rows).toHaveLength(0);
  });

  test('Bun.file reader on src/ is structural', () => {
    const src = [
      "const text = await Bun.file(new URL('../src/core/migrate.ts', import.meta.url)).text();",
      "describe('migrate shape', () => {",
      "  test('pin', () => { expect(text).toContain('MIGRATIONS'); });",
      '});',
    ].join('\n');
    const rows = classifyFile('test/fake.test.ts', src).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].detector).toBe('bun-file');
  });

  test('exec grep over src/ is structural; exec of product CLI is not', () => {
    const grep = [
      "describe('grep guard', () => {",
      "  test('scan', () => {",
      "    const out = execSync(`grep -rn 'pattern' src/ --include=*.ts`);",
      '  });',
      '});',
    ].join('\n');
    expect(classifyFile('test/fake.test.ts', grep).rows).toHaveLength(1);
    const cli = [
      "describe('cli run', () => {",
      "  test('runs', () => {",
      "    const out = execSync('bun run src/cli.ts --version', { cwd: tmpDir });",
      '  });',
      '});',
    ].join('\n');
    expect(classifyFile('test/fake.test.ts', cli).rows).toHaveLength(0);
  });

  test('doctor-source helper marks the suite structural', () => {
    const src = [
      "import { doctorSource } from './helpers/doctor-source.ts';",
      "describe('doctor pin', () => {",
      "  test('has check', () => { expect(doctorSource()).toContain('checkX'); });",
      '});',
    ].join('\n');
    const rows = classifyFile('test/fake.test.ts', src).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].detector).toBe('doctor-source-helper');
  });

  test('detector outside any describe attributes to file-level pseudo-suite', () => {
    const src = [
      "const SRC = readFileSync('src/core/operations.ts', 'utf-8');",
      "test('top-level pin', () => { expect(SRC).toContain('Operation'); });",
    ].join('\n');
    const res = classifyFile('test/fake.test.ts', src);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].suite).toBe('(file-level)');
    expect(res.rows[0].cases).toBe(1);
  });

  test('binding names with regex metachars ($) are escaped, not read as anchors', () => {
    // `$SRC` interpolated unescaped becomes /\b$SRC\b/ — `$` reads as an
    // end-anchor and the binding can never match, so attribution silently
    // falls through to the (file-level) pseudo-suite.
    const src = [
      "const $SRC = readFileSync('src/core/operations.ts', 'utf-8');",
      "describe('uses dollar binding', () => {",
      "  test('pin', () => { expect($SRC).toContain('Operation'); });",
      '});',
    ].join('\n');
    const res = classifyFile('test/fake.test.ts', src);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].suite).toBe('uses dollar binding');
    expect(res.rows[0].detector).toBe('readFileSync');
  });

  test('comment lines never trigger detectors', () => {
    const src = [
      "// reads src/commands/doctor.ts via readFileSync at runtime",
      "describe('behavioral', () => {",
      "  test('x', () => { expect(1).toBe(1); });",
      '});',
    ].join('\n');
    expect(classifyFile('test/fake.test.ts', src).rows).toHaveLength(0);
  });
});
