import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as records from '../src/core/persistence/physical-root-record.ts';

function fixture(run: (root: string, old: string, file: string, identity: { brainId: string; worktreeId: string; hostId: string; coordinationPath: string }) => void) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'physical-bind-existing-'))), old = join(home, 'old'), root = join(home, 'current');
  try {
    mkdirSync(old); mkdirSync(join(home, 'locks'));
    const identity = { brainId: randomUUID(), worktreeId: randomUUID(), hostId: randomUUID(), coordinationPath: join(home, 'locks', 'existing.lock') };
    const reservation = records.reservePhysicalRootRecord(old, identity); records.writePhysicalRootStamp(old, reservation); renameSync(old, root);
    run(root, old, records.physicalRootReservationPath(old), identity);
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const inspect = (root: string, file: string, identity: unknown) => {
  const method = (records as unknown as Record<string, unknown>).inspectMovedReservation;
  expect(typeof method).toBe('function');
  return (method as (r: string, f: string, i: unknown) => unknown)(root, file, identity);
};

test('rejects copied directory despite matching token', () => fixture((root, old, file, identity) => {
  expect(inspect(root, file, identity)).toBeDefined();
  const copy = join(root, '..', 'copied'); cpSync(root, copy, { recursive: true });
  expect(() => inspect(copy, file, identity)).toThrow();
  const marker = join(root, '.gbrain-owner.json'), before = readFileSync(marker, 'utf8'), value = JSON.parse(before);
  for (const field of ['device', 'inode', 'birth']) {
    writeFileSync(marker, JSON.stringify({ ...value, [field]: String(BigInt(value[field]) + 100000n) }), { mode: 0o600 });
    expect(() => inspect(root, file, identity)).toThrow();
  }
  writeFileSync(marker, before); expect(() => inspect(root, file, { ...identity, worktreeId: randomUUID() })).toThrow();
  expect(() => inspect(root, file, { ...identity, brainId: randomUUID() })).toThrow();
  expect(() => inspect(root, file, { ...identity, hostId: randomUUID() })).toThrow();
  expect(() => inspect(root, file, { ...identity, coordinationPath: join(root, '..', 'locks', 'other.lock') })).toThrow();
}));

test('rejects foreign reservation and unsafe metadata', () => fixture((root, _old, file, identity) => {
  expect(inspect(root, file, identity)).toBeDefined();
  chmodSync(file, 0o644); expect(() => inspect(root, file, identity)).toThrow(); chmodSync(file, 0o600);
  const other = join(root, '..', '.gbrain-owner-wrong.json'); cpSync(file, other); expect(() => inspect(root, other, identity)).toThrow();
}));

for (const hazard of ['current-reservation', 'second-candidate', 'record-link', 'stamp-hardlink', 'root-link', 'parent-link', 'dangling-history', 'external-file', 'reservation-device', 'reservation-inode', 'reservation-birth', 'stamp-brain', 'stamp-worktree']) {
  test(`rejects foreign reservation and unsafe metadata: ${hazard}`, () => fixture((root, old, file, identity) => {
    const marker = join(root, '.gbrain-owner.json'), home = join(root, '..');
    expect(inspect(root, file, identity)).toBeDefined();
    if (hazard === 'current-reservation') cpSync(file, records.physicalRootReservationPath(root));
    else if (hazard === 'second-candidate') cpSync(file, join(home, '.gbrain-owner-conflicting.json'));
    else if (hazard === 'record-link') { renameSync(file, file + '.retained'); symlinkSync(file + '.retained', file); }
    else if (hazard === 'stamp-hardlink') linkSync(marker, marker + '.linked');
    else if (hazard === 'dangling-history') symlinkSync(join(home, 'missing'), old);
    else if (hazard === 'root-link') { const alias = join(home, 'alias'); symlinkSync(root, alias); expect(() => inspect(alias, file, identity)).toThrow(); return; }
    else if (hazard === 'parent-link') { const alias = join(home, 'parent-alias'); symlinkSync(home, alias); expect(() => inspect(join(alias, 'current'), file, identity)).toThrow(); return; }
    else if (hazard === 'external-file') { const external = join(home, 'external'); mkdirSync(external); const candidate = join(external, file.split('/').pop()!); cpSync(file, candidate); expect(() => inspect(root, candidate, identity)).toThrow(); return; }
    else if (hazard.startsWith('reservation-')) { const value = JSON.parse(readFileSync(file, 'utf8')), key = hazard === 'reservation-device' ? 'initialDevice' : hazard === 'reservation-inode' ? 'initialInode' : 'initialBirth'; value[key] = String(BigInt(value[key]) + 100000n); writeFileSync(file, JSON.stringify(value)); }
    else { const value = JSON.parse(readFileSync(marker, 'utf8')); value[hazard === 'stamp-brain' ? 'brainId' : 'worktreeId'] = randomUUID(); writeFileSync(marker, JSON.stringify(value)); }
    expect(() => inspect(root, file, identity)).toThrow();
  }));
}

for (const encoding of ['escaped-duplicate-value', 'escaped-duplicate-key', 'escaped-shadow-value']) {
  test(`P2 token recovery rejects ${encoding}`, () => fixture((root, _old, file, identity) => {
    const bytes = readFileSync(file, 'utf8'), token = JSON.parse(bytes).token as string;
    const escaped = '"\\u' + token.charCodeAt(0).toString(16).padStart(4, '0') + token.slice(1) + '"';
    const extra = encoding === 'escaped-duplicate-value' ? '"token":' + escaped
      : encoding === 'escaped-duplicate-key' ? '"to\\u006ben":' + escaped : '"shadow":' + escaped;
    writeFileSync(file, '{' + extra + ',' + bytes.slice(1));
    expect(() => inspect(root, file, identity)).toThrow();
  }));
}

test('P2 FIFO ownership metadata rejects without blocking the resident loop', () => fixture((root, _old, file, identity) => {
  unlinkSync(file); execFileSync('mkfifo', ['-m', '600', file]);
  const source = `import { inspectMovedReservation } from ${JSON.stringify(import.meta.resolve('../src/core/persistence/physical-root-record.ts'))};
    try { inspectMovedReservation(${JSON.stringify(root)}, ${JSON.stringify(file)}, ${JSON.stringify(identity)}); console.log('accepted'); }
    catch { console.log('rejected'); }`;
  const result = spawnSync(process.execPath, ['-e', source], { timeout: 2000, encoding: 'utf8' });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('rejected');
}));

function recoveryStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, part]) => [key, ...recoveryStrings(part)]);
}

for (const target of ['reservation', 'stamp']) {
  for (const encoding of ['appended-string', 'repeated-substrings', 'nested-string', 'property-name', 'duplicate-key', 'escaped-value', 'escaped-key', 'escaped-shadow']) {
    test(`R1 all recovery strings exclude token: ${target} ${encoding}`, () => fixture((root, _old, file, identity) => {
      const path = target === 'reservation' ? file : join(root, '.gbrain-owner.json');
      const bytes = readFileSync(path, 'utf8'), value = JSON.parse(bytes), token = value.token as string;
      expect(recoveryStrings(inspect(root, file, identity)).every(part => !part.includes(token))).toBe(true);
      const escaped = '"\\u' + token.charCodeAt(0).toString(16).padStart(4, '0') + token.slice(1) + '"';
      const mutated = encoding === 'appended-string' ? JSON.stringify({ ...value, shadow: `prefix-${token}-suffix` })
        : encoding === 'repeated-substrings' ? JSON.stringify({ ...value, shadow: `prefix-${token}-${token}`, nested: [token] })
        : encoding === 'nested-string' ? JSON.stringify({ ...value, nested: [{ shadow: `prefix-${token}-suffix` }] })
        : encoding === 'property-name' ? JSON.stringify({ ...value, [`prefix-${token}-suffix`]: 'shadow' })
        : encoding === 'duplicate-key' ? '{"token":' + JSON.stringify(token) + ',' + bytes.slice(1)
        : encoding === 'escaped-key' ? '{"to\\u006ben":' + escaped + ',' + bytes.slice(1)
        : encoding === 'escaped-shadow' ? bytes.slice(0, -1) + ',"shadow":' + escaped + '}'
        : bytes.replace(JSON.stringify(token), escaped);
      writeFileSync(path, mutated);
      let proof: unknown;
      try { proof = inspect(root, file, identity); }
      catch (error) { expect((error as { code?: string }).code).toBe('recovery_required'); }
      if (proof !== undefined) {
        expect(recoveryStrings(proof).every(part => !part.includes(token))).toBe(true);
        expect(JSON.stringify(proof).includes(token)).toBe(false);
      }
    }));
  }
}

for (const placement of ['sibling', 'reservation', 'stamp']) {
  test(`R2 private reader rejects real FIFO before open: ${placement}`, () => fixture((root, old, file, identity) => {
    const path = placement === 'sibling' ? join(root, '..', '.gbrain-owner-sibling-fifo.json')
      : placement === 'reservation' ? file : join(root, '.gbrain-owner.json');
    if (placement !== 'sibling') unlinkSync(path);
    execFileSync('mkfifo', ['-m', '600', path]);
    const call = placement === 'sibling' ? `records.inspectMovedReservation(${JSON.stringify(root)}, ${JSON.stringify(file)}, ${JSON.stringify(identity)})`
      : placement === 'reservation' ? `records.readRecordedPhysicalRootReservation(${JSON.stringify(old)})`
      : `records.readPhysicalRootStamp(${JSON.stringify(root)})`;
    const source = `import * as records from ${JSON.stringify(import.meta.resolve('../src/core/persistence/physical-root-record.ts'))};
      try { ${call}; console.log('accepted'); }
      catch (error) { console.log(error.code === 'recovery_required' ? 'rejected' : 'unexpected'); }`;
    const result = spawnSync(process.execPath, ['-e', source], { timeout: 2000, killSignal: 'SIGKILL', encoding: 'utf8' });
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).not.toBe('ETIMEDOUT');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('rejected');
  }));
}
