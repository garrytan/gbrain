import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  configuredRootImportError,
  ImportAbortError,
  listConfiguredRoots,
  runImport,
} from '../src/commands/import.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
let root: string;
let outside: string;
const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

beforeEach(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  root = tempDir('gbrain-configured-root-');
  outside = tempDir('gbrain-configured-outside-');
  writeFileSync(join(root, 'canonical.md'), '# canonical\n');
  writeFileSync(join(outside, 'outside.md'), '# outside\n');
  await engine.setConfig('import.require_configured_root', 'true');
  await engine.executeRaw(
    'UPDATE sources SET local_path = $1 WHERE id = $2',
    [root, 'default'],
  );
});

afterEach(async () => {
  await engine.disconnect();
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('configuredRootImportError', () => {
  test('admits an equal configured root', () => {
    expect(configuredRootImportError(root, [root])).toBeNull();
  });

  test('admits a descendant of a configured root', () => {
    const child = join(root, 'child');
    mkdirSync(child);
    expect(configuredRootImportError(child, [root])).toBeNull();
  });

  test('a filesystem root admits its descendants', () => {
    expect(configuredRootImportError(root, ['/'])).toBeNull();
  });

  test('refuses an unrelated directory with an override hint', () => {
    const error = configuredRootImportError(outside, [root]);
    expect(error).toContain('not under the configured root');
    expect(error).toContain('--allow-noncanonical-root');
  });

  test('refuses a sibling whose name merely shares the root prefix', () => {
    const parent = tempDir('gbrain-prefix-parent-');
    const admitted = join(parent, 'brain');
    const sibling = join(parent, 'brain-copy');
    mkdirSync(admitted);
    mkdirSync(sibling);
    expect(configuredRootImportError(sibling, [admitted])).not.toBeNull();
  });

  test('treats a symlink and its canonical target as the same root', () => {
    const parent = tempDir('gbrain-root-link-');
    const link = join(parent, 'brain-link');
    symlinkSync(root, link);
    expect(configuredRootImportError(root, [link])).toBeNull();
    expect(configuredRootImportError(link, [root])).toBeNull();
  });
});

describe('destination-scoped configured roots', () => {
  test('default includes its local path and the legacy sync root', async () => {
    const legacy = tempDir('gbrain-legacy-root-');
    await engine.setConfig('sync.repo_path', legacy);
    expect(await listConfiguredRoots(engine, 'default')).toEqual([root, legacy]);
  });

  test('a side destination includes only its own local path', async () => {
    const sideRoot = tempDir('gbrain-side-root-');
    await engine.setConfig('sync.repo_path', tempDir('gbrain-legacy-root-'));
    await engine.executeRaw(
      'INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)',
      ['side', sideRoot],
    );
    expect(await listConfiguredRoots(engine, 'side')).toEqual([sideRoot]);
  });

  test('root discovery errors reject instead of becoming an empty root set', async () => {
    const original = engine.executeRaw.bind(engine);
    const query = spyOn(engine, 'executeRaw').mockImplementation((async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT local_path FROM sources')) throw new Error('unavailable');
      return original(sql, params);
    }) as typeof engine.executeRaw);
    try {
      await expect(listConfiguredRoots(engine, 'default')).rejects.toThrow(
        /Cannot determine configured source roots/,
      );
    } finally {
      query.mockRestore();
    }
  });
});

describe('runImport configured-root admission', () => {
  test('strict mode refuses an outside directory before importing', async () => {
    await expect(
      runImport(engine, [outside, '--no-embed'], { sourceId: 'default' }),
    ).rejects.toBeInstanceOf(ImportAbortError);
    const rows = await engine.executeRaw<{ n: number | string }>(
      'SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL',
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  test('strict mode admits the destination source root', async () => {
    const result = await runImport(engine, [root, '--no-embed'], { sourceId: 'default' });
    expect(result.imported).toBeGreaterThan(0);
  });

  test('the explicit override admits an outside directory', async () => {
    const result = await runImport(
      engine,
      [outside, '--no-embed', '--allow-noncanonical-root'],
      { sourceId: 'default' },
    );
    expect(result.imported).toBeGreaterThan(0);
  });

  test('default-off behavior admits an outside directory', async () => {
    await engine.executeRaw(
      'DELETE FROM config WHERE key = $1',
      ['import.require_configured_root'],
    );
    const result = await runImport(engine, [outside, '--no-embed'], { sourceId: 'default' });
    expect(result.imported).toBeGreaterThan(0);
  });

  test('strict mode with no destination root fails closed', async () => {
    await engine.executeRaw(
      'UPDATE sources SET local_path = NULL WHERE id = $1',
      ['default'],
    );
    await expect(
      runImport(engine, [outside, '--no-embed'], { sourceId: 'default' }),
    ).rejects.toBeInstanceOf(ImportAbortError);
  });

  test('one source root cannot launder content into another destination', async () => {
    const sideRoot = tempDir('gbrain-side-import-');
    writeFileSync(join(sideRoot, 'side.md'), '# side\n');
    await engine.executeRaw(
      'INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)',
      ['side', sideRoot],
    );
    await expect(
      runImport(engine, [sideRoot, '--no-embed'], { sourceId: 'default' }),
    ).rejects.toBeInstanceOf(ImportAbortError);
    await expect(
      runImport(engine, [root, '--no-embed'], { sourceId: 'side' }),
    ).rejects.toBeInstanceOf(ImportAbortError);
  });

  test('root discovery failure stops before import', async () => {
    const original = engine.executeRaw.bind(engine);
    const query = spyOn(engine, 'executeRaw').mockImplementation((async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT local_path FROM sources')) throw new Error('unavailable');
      return original(sql, params);
    }) as typeof engine.executeRaw);
    try {
      await expect(
        runImport(engine, [root, '--no-embed'], { sourceId: 'default' }),
      ).rejects.toBeInstanceOf(ImportAbortError);
    } finally {
      query.mockRestore();
    }
  });
});

test('--allow-noncanonical-root is registered only for import', () => {
  expect(CLI_FLAG_REGISTRY.import).toContain('--allow-noncanonical-root');
  for (const [command, flags] of Object.entries(CLI_FLAG_REGISTRY)) {
    if (command !== 'import') expect(flags).not.toContain('--allow-noncanonical-root');
  }
});
