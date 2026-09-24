import { describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { safeLoad } from 'js-yaml';
import manifest from '../../native/locks/manifest.json';

const repo = join(import.meta.dir, '../..');
function verify(root: string) {
  return spawnSync(process.execPath, ['scripts/native/verify.ts'], { cwd: root, encoding: 'utf8' });
}

function windowsImports(binary: Buffer): string[] {
  const pe = binary.readUInt32LE(0x3c);
  expect(binary.toString('ascii', pe, pe + 4)).toBe('PE\0\0');
  const optional = pe + 24;
  expect(binary.readUInt16LE(optional)).toBe(0x20b);
  const sectionTable = optional + binary.readUInt16LE(pe + 20);
  const offset = (rva: number) => {
    for (let i = 0; i < binary.readUInt16LE(pe + 6); i++) {
      const section = sectionTable + i * 40;
      const start = binary.readUInt32LE(section + 12);
      const length = Math.max(binary.readUInt32LE(section + 8), binary.readUInt32LE(section + 16));
      if (rva >= start && rva < start + length) return binary.readUInt32LE(section + 20) + rva - start;
    }
    throw new Error(`PE import RVA ${rva} has no section`);
  };
  const names: string[] = [];
  for (let entry = offset(binary.readUInt32LE(optional + 120)); binary.readUInt32LE(entry + 12); entry += 20) {
    const start = offset(binary.readUInt32LE(entry + 12));
    names.push(binary.toString('ascii', start, binary.indexOf(0, start)).toLowerCase());
  }
  return names;
}

describe('native lock distribution integrity', () => {
  test('all eight vendored binaries match the current source and hash manifest', () => {
    const result = verify(repo);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Verified 8 native lock prebuilds');
  });

  test.each(['win32-x64', 'win32-arm64'])('%s binds Node-API to its host without loading another runtime', target => {
    const imports = windowsImports(readFileSync(join(repo, `native/locks/prebuilds/${target}.node`)));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter(name => name.endsWith('.exe') || name === 'node.dll' || name === 'libnode.dll')).toEqual([]);
  });

  test.each(['binary', 'source'])('verification rejects changed %s bytes', (changed) => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-native-manifest-'));
    try {
      cpSync(join(repo, 'native/locks'), join(root, 'native/locks'), { recursive: true });
      cpSync(join(repo, 'scripts/native'), join(root, 'scripts/native'), { recursive: true });
      const file = join(root, changed === 'source'
        ? 'native/locks/locks.c' : 'native/locks/prebuilds/linux-x64-glibc.node');
      const bytes = readFileSync(file);
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(file, bytes);
      const result = verify(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(changed === 'source' ? 'source changed' : 'integrity mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('required CI executes every declared target at both supported Bun versions', () => {
    type NativeJob = {
      strategy: { matrix: { bun: string[]; target: string[]; include: Array<{ runner: string; target: string }> } };
      steps: Array<{ run?: string }>;
    };
    const workflow = safeLoad(readFileSync(join(repo, '.github/workflows/native-locks.yml'), 'utf8')) as {
      jobs: Record<string, NativeJob>;
    };
    const pairs: string[] = [];
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name === 'openclaw') {
        expect(job.steps.some(step => step.run?.includes('test/openclaw-context-engine-native.serial.test.ts'))).toBe(true);
        continue;
      }
      if (name === 'windows-backup-console') {
        expect(job.steps.some(step => step.run?.includes('Windows backup console controls:'))).toBe(true);
        expect(job.steps.some(step => step.run === 'bun scripts/native/verify.ts')).toBe(true);
        continue;
      }
      if (name === 'windows-backup-dotnet') {
        expect(job.steps.some(step => step.run?.includes('Windows backup dotnet controls:'))).toBe(true);
        expect(job.steps.some(step => step.run === 'bun scripts/native/verify.ts')).toBe(true);
        continue;
      }
      const matrix = job.strategy.matrix;
      expect(matrix.bun).toEqual(['1.3.11', '1.3.13', '1.4.2']);
      const script = job.steps.map(step => step.run ?? '').join('\n');
      expect(script).toContain('bun install --frozen-lockfile --ignore-scripts');
      const lockTests = script.split('\n').find(line => /\bbun test\b/.test(line) && line.includes('test/native-lock.test.ts'));
      expect(lockTests).toBeDefined();
      expect(lockTests!).toMatch(/--timeout(?:=|\s+)[1-9]\d*\b/);
      expect(lockTests!).toContain('test/pglite-lock.test.ts');
      expect(lockTests!).toContain('test/local-ipc-path.test.ts');
      expect(script).toContain('bun scripts/native/compiled-smoke.ts');
      expect(script).toContain('bun scripts/native/verify.ts --rebuilt');
      for (const target of matrix.target) {
        expect(matrix.include.filter(entry => entry.target === target).length).toBe(1);
        for (const bun of matrix.bun) pairs.push(`${target}/${bun}`);
      }
    }
    expect(pairs.sort()).toEqual(Object.keys(manifest.artifacts)
      .flatMap(target => ['1.3.11', '1.3.13', '1.4.2'].map(bun => `${target}/${bun}`)).sort());
    expect(new Set(pairs).size).toBe(24);
  });
});
