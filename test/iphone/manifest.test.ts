import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTACTS_DOMAIN,
  CONTACTS_RELATIVE_PATH,
  IPhoneBackupManifest,
  SMS_DOMAIN,
  SMS_RELATIVE_PATH,
  resolveBackupFilePath,
} from '../../src/core/iphone/manifest.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'iphone-backup', 'backup');

describe('iPhone backup manifest', () => {
  test('resolves sms.db from Manifest.db to the sharded backup path', () => {
    const manifest = new IPhoneBackupManifest(FIXTURE);
    const ref = manifest.resolveFile(SMS_DOMAIN, SMS_RELATIVE_PATH);
    manifest.close();

    expect(ref?.domain).toBe('HomeDomain');
    expect(ref?.relativePath).toBe('Library/SMS/sms.db');
    expect(ref?.fileID).toMatch(/^[0-9a-f]{40}$/);
    expect(ref?.path).toContain(`/backup/${ref!.fileID.slice(0, 2)}/${ref!.fileID}`);
  });

  test('resolves AddressBook.sqlitedb from Manifest.db', () => {
    const manifest = new IPhoneBackupManifest(FIXTURE);
    const ref = manifest.resolveFile(CONTACTS_DOMAIN, CONTACTS_RELATIVE_PATH);
    manifest.close();

    expect(ref?.relativePath).toBe('Library/AddressBook/AddressBook.sqlitedb');
    expect(ref?.path).toContain(`/backup/${ref!.fileID.slice(0, 2)}/${ref!.fileID}`);
  });

  test('returns null when a store is absent', () => {
    const manifest = new IPhoneBackupManifest(FIXTURE);
    const ref = manifest.resolveFile('HomeDomain', 'Library/Email/not-present.db');
    manifest.close();

    expect(ref).toBeNull();
  });

  test('resolveBackupFilePath supports flat legacy backup layout', () => {
    const id = 'a'.repeat(40);
    const path = resolveBackupFilePath('/backup', id, (candidate) => candidate === `/backup/${id}`);
    expect(path).toBe(`/backup/${id}`);
  });

  test('rejects traversal-shaped file IDs before touching the filesystem', () => {
    const path = resolveBackupFilePath('/backup', '../Manifest.db', () => true);
    expect(path).toBeNull();
  });

  test('rejects symlinked backup payloads even when the sharded path exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-iphone-manifest-'));
    const outside = join(root, 'outside.db');
    const backup = join(root, 'backup');
    const id = 'b'.repeat(40);
    try {
      writeFileSync(outside, 'not sqlite');
      mkdirSync(join(backup, id.slice(0, 2)), { recursive: true });
      symlinkSync(outside, join(backup, id.slice(0, 2), id));

      expect(resolveBackupFilePath(backup, id)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
