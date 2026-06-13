import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeSchemaBuildFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mbrain-schema-build-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src', 'core'), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts', 'build-schema.sh'), join(root, 'scripts', 'build-schema.sh'));
  copyFileSync(join(repoRoot, 'src', 'schema.sql'), join(root, 'src', 'schema.sql'));
  return root;
}

function runBuildSchema(root: string, args: string[] = []) {
  return Bun.spawnSync({
    cmd: ['bash', 'scripts/build-schema.sh', ...args],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function outputText(proc: ReturnType<typeof runBuildSchema>): string {
  return `${new TextDecoder().decode(proc.stdout)}${new TextDecoder().decode(proc.stderr)}`;
}

describe('schema generation', () => {
  test('build-schema generates both embedded Postgres and PGLite schema files', () => {
    const root = makeSchemaBuildFixture();

    const proc = runBuildSchema(root);

    expect(proc.exitCode).toBe(0);
    const embedded = readFileSync(join(root, 'src', 'core', 'schema-embedded.ts'), 'utf-8');
    const pglite = readFileSync(join(root, 'src', 'core', 'pglite-schema.ts'), 'utf-8');
    expect(embedded).toContain('export const SCHEMA_SQL = `');
    expect(pglite).toContain('export const PGLITE_SCHEMA_SQL = `');
    expect(pglite).toContain('page_embedding vector(1024)');
    expect(pglite).toContain("('engine', 'pglite')");
    expect(pglite).not.toContain('CREATE TABLE IF NOT EXISTS access_tokens');
    expect(pglite).not.toContain('ENABLE ROW LEVEL SECURITY');
  });

  test('build-schema --check fails when generated schemas drift from schema.sql', () => {
    const root = makeSchemaBuildFixture();
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    writeFileSync(join(root, 'src', 'core', 'schema-embedded.ts'), '// drifted embedded schema\n');
    writeFileSync(join(root, 'src', 'core', 'pglite-schema.ts'), '// drifted pglite schema\n');

    const proc = runBuildSchema(root, ['--check']);
    const output = outputText(proc);

    expect(proc.exitCode).not.toBe(0);
    expect(output).toContain('schema-embedded.ts');
    expect(output).toContain('pglite-schema.ts');
  });
});
