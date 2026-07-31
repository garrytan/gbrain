import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');
const GUARD = resolve(REPO_ROOT, 'scripts', 'check-engine-dynamic-import.sh');
const VERIFY_DISPATCHER = resolve(REPO_ROOT, 'scripts', 'run-verify-parallel.sh');
const BASH = process.platform === 'win32'
  ? resolve(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  : 'bash';
const tempDirs: string[] = [];

setDefaultTimeout(30_000);

function fixture(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-engine-import-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

function runGuard(files: string[] = [], cwd = REPO_ROOT) {
  const result = spawnSync(BASH, [GUARD, ...files], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-engine-dynamic-import.sh', () => {
  it('exists', () => {
    expect(existsSync(GUARD)).toBe(true);
  });

  it('rejects and reports an unmarked dynamic import', () => {
    const path = fixture('violator.ts', "async function load() {\n  return await import('./helper.ts');\n}\n");
    const result = runGuard([path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${basename(path)}:2:`);
    expect(result.stderr).toContain("await import('./helper.ts')");
  });

  it('allows a same-line marker for multiple non-gateway imports and ignores comment-only matches', () => {
    const path = fixture(
      'allowed.ts',
      [
        "// await import('./comment.ts')",
        '/*',
        " * await import('./block-body.ts')",
        ' */',
        "const first = import('./first.ts'); const second = import('./second.ts'); // engine-dynamic-import-ok",
        '',
      ].join('\n'),
    );
    const result = runGuard([path]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('check-engine-dynamic-import: ok (1 file(s) scanned)');
  });

  it('rejects live code after a closed leading block comment', () => {
    const path = fixture(
      'leading-block-comment.ts',
      "/* load only when needed */ const helper = await import('./helper.ts');\n",
    );
    const result = runGuard([path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${basename(path)}:1:`);
    expect(result.stderr).toContain("await import('./helper.ts')");
  });

  it('ignores dynamic-import text wholly inside a multiline block comment', () => {
    const path = fixture(
      'multiline-block-comment.ts',
      [
        '/*',
        " * await import('./comment-only.ts')",
        ' */',
        'const value = 1;',
        '',
      ].join('\n'),
    );
    const result = runGuard([path]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('check-engine-dynamic-import: ok (1 file(s) scanned)');
  });

  it('reports every violation across multiple files', () => {
    const first = fixture(
      'first-violator.ts',
      "const first = await import('./first.ts');\nconst second = await import('./second.ts');\n",
    );
    const second = fixture(
      'second-violator.ts',
      "/* explanation */ const third = await import('./third.ts');\n",
    );
    const result = runGuard([first, second]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${basename(first)}:1:`);
    expect(result.stderr).toContain(`${basename(first)}:2:`);
    expect(result.stderr).toContain(`${basename(second)}:1:`);
  }, 30_000);

  it('does not mistake comment delimiters inside literals for comments', () => {
    const path = fixture(
      'literal-delimiters.ts',
      [
        'const url = "https://example.test";',
        'const block = "/* not a comment";',
        'const template = `https://example.test`;',
        'const pattern = /\\/\\//;',
        "const helper = await import('./helper.ts');",
        '',
      ].join('\n'),
    );
    const result = runGuard([path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${basename(path)}:5:`);
  }, 30_000);

  it('detects bare and trivia-separated dynamic imports', () => {
    const path = fixture(
      'dynamic-import-syntax.ts',
      [
        "const first = import('./first.ts');",
        "const second = await import /* explanation */ ('./second.ts');",
        '',
      ].join('\n'),
    );
    const result = runGuard([path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${basename(path)}:1:`);
    expect(result.stderr).toContain(`${basename(path)}:2:`);
  }, 30_000);

  it('detects live code after a multiline block comment closes', () => {
    const path = fixture(
      'after-multiline-comment.ts',
      "/*\n * explanation\n */ const helper = await import('./helper.ts');\n",
    );
    const result = runGuard([path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${basename(path)}:3:`);
  });

  it('requires the allow marker on the import line', () => {
    const path = fixture(
      'marker-line.ts',
      "// engine-dynamic-import-ok\nconst helper = await import('./helper.ts');\n",
    );
    const result = runGuard([path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${basename(path)}:2:`);
  });

  it('does not accept marker text outside comment trivia or within longer comment tokens', () => {
    const path = fixture(
      'marker-text.ts',
      [
        "const first = import('./engine-dynamic-import-ok.ts');",
        "const marker = 'engine-dynamic-import-ok'; const second = import('./second.ts');",
        'const template = `prefix',
        '// engine-dynamic-import-ok ${import("./third.ts")}`;',
        "const fourth = import('./fourth.ts'); // no-engine-dynamic-import-ok: not approved",
        '',
      ].join('\n'),
    );
    const result = runGuard([path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${basename(path)}:1:`);
    expect(result.stderr).toContain(`${basename(path)}:2:`);
    expect(result.stderr).toContain(`${basename(path)}:4:`);
    expect(result.stderr).toContain(`${basename(path)}:5:`);
  });

  it('does not accept markers adjacent to Unicode identifier characters', () => {
    const path = fixture(
      'unicode-marker-text.ts',
      [
        "const first = import('./first.ts'); // noéengine-dynamic-import-ok: not approved",
        "const second = import('./second.ts'); // engine-dynamic-import-oké: not approved",
        "const third = import('./third.ts'); // éengine-dynamic-import-oké: not approved",
        "const fourth = import('./fourth.ts'); // nóengine-dynamic-import-ok: not approved",
        "const fifth = import('./fifth.ts'); // 𐐀engine-dynamic-import-ok: not approved",
        "const sixth = import('./sixth.ts'); // engine-dynamic-import-ok𐐀: not approved",
        '',
      ].join('\n'),
    );
    const result = runGuard([path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${basename(path)}:1:`);
    expect(result.stderr).toContain(`${basename(path)}:2:`);
    expect(result.stderr).toContain(`${basename(path)}:3:`);
    expect(result.stderr).toContain(`${basename(path)}:4:`);
    expect(result.stderr).toContain(`${basename(path)}:5:`);
    expect(result.stderr).toContain(`${basename(path)}:6:`);
  });

  it('allows a marker in real multiline comment trivia on the import line', () => {
    const path = fixture(
      'multiline-marker.ts',
      [
        '/* rationale',
        ' * engine-dynamic-import-ok */ const helper = import("./helper.ts");',
        '',
      ].join('\n'),
    );
    const result = runGuard([path]);
    expect(result.code).toBe(0);
  });

  it('fails on TypeScript parse diagnostics', () => {
    const path = fixture('malformed.ts', 'const broken = ;\n');
    const result = runGuard([path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cannot parse input file');
    expect(result.stderr).toContain(basename(path));
  });

  it('reports recovered-AST violations alongside parse diagnostics', () => {
    const path = fixture(
      'malformed-violator.ts',
      "const helper = import('./helper.ts');\nconst broken = ;\n",
    );
    const result = runGuard([path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cannot parse input file');
    expect(result.stderr).toContain(`${basename(path)}:1:`);
  });

  it('ignores type-position imports', () => {
    const path = fixture(
      'type-import.ts',
      "type Helper = import('./helper.ts').Helper;\n",
    );
    const result = runGuard([path]);
    expect(result.code).toBe(0);
  });

  it('reports readable-file violations alongside missing inputs', () => {
    const path = fixture('mixed-violator.ts', "const helper = import('./helper.ts');\n");
    const missing = join(tmpdir(), `gbrain-engine-import-missing-${process.pid}.ts`);
    const result = runGuard([path, missing]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${basename(path)}:1:`);
    expect(result.stderr).toContain('cannot read input file');
    expect(result.stderr).toContain(basename(missing));
  });

  it('fails when an explicit input file is missing', () => {
    const missing = join(tmpdir(), `gbrain-engine-import-missing-${process.pid}.ts`);
    const result = runGuard([missing]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cannot read input file');
    expect(result.stderr).toContain(basename(missing));
  });

  it('resolves default inputs from the guard repository', () => {
    const foreign = mkdtempSync(join(tmpdir(), 'gbrain-engine-import-foreign-'));
    tempDirs.push(foreign);
    const foreignCore = join(foreign, 'src', 'core');
    mkdirSync(foreignCore, { recursive: true });
    expect(spawnSync('git', ['init', '-q'], { cwd: foreign }).status).toBe(0);
    writeFileSync(
      join(foreignCore, 'pglite-engine.ts'),
      "const foreign = import('./foreign.ts');\n",
      'utf8',
    );
    for (const name of ['postgres-engine.ts', 'migrate.ts']) {
      writeFileSync(join(foreignCore, name), '', 'utf8');
    }

    const result = runGuard([], foreign);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('check-engine-dynamic-import: ok (3 file(s) scanned)');
  }, 30_000);

  it('still catches a violation in CRLF input', () => {
    const path = fixture('crlf.ts', "async function load() {\r\n  return await import('./helper.ts');\r\n}\r\n");
    const result = runGuard([path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${basename(path)}:2:`);
  });

  it('passes on the reconciled repository sources', () => {
    const result = runGuard();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('check-engine-dynamic-import: ok (3 file(s) scanned)');
  }, 30_000);
});

describe('engine dynamic-import guard wiring', () => {
  it('is invoked through bash by check:all', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check:engine-dynamic-import']).toBe(
      'bash scripts/check-engine-dynamic-import.sh',
    );
    expect(pkg.scripts['check:all']).toContain(
      'bash scripts/check-engine-dynamic-import.sh',
    );
  });

  it('is listed by the authoritative verify dispatcher', () => {
    const result = spawnSync(BASH, [VERIFY_DISPATCHER, '--dry-list'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(new Set((result.stdout ?? '').trim().split('\n'))).toContain(
      'check:engine-dynamic-import',
    );
  });
});
