import { describe, expect, it } from 'bun:test';
import * as crypto from 'node:crypto';
import {
  computeSnapshotSchemaHash,
  createSnapshotMetadata,
  isSnapshotMetadataCompatible,
} from '../src/core/pglite-engine.ts';

const schema1536 = 'CREATE TABLE chunks (embedding vector(1536));';

function migration(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    name: 'fixture',
    sql: '',
    transaction: true,
    idempotent: true,
    handler: async () => { /* fixture-v1 */ },
    verify: async () => true,
    ...overrides,
  };
}

describe('PGLite snapshot compatibility metadata', () => {
  it('changes the compatibility hash when rendered schema changes', () => {
    const a = computeSnapshotSchemaHash([migration()], schema1536, crypto);
    const b = computeSnapshotSchemaHash([migration()], 'CREATE TABLE chunks (embedding vector(1280));', crypto);
    expect(a).not.toBe(b);
  });

  it('changes the compatibility hash when a migration handler changes', () => {
    const a = computeSnapshotSchemaHash(
      [migration({ handler: async () => 1 })],
      schema1536,
      crypto,
    );
    const b = computeSnapshotSchemaHash(
      [migration({ handler: async () => 2 })],
      schema1536,
      crypto,
    );
    expect(a).not.toBe(b);
  });

  it('changes the compatibility hash when verify/transaction semantics change', () => {
    const a = computeSnapshotSchemaHash([migration()], schema1536, crypto);
    const b = computeSnapshotSchemaHash(
      [migration({ transaction: false, verify: async () => false })],
      schema1536,
      crypto,
    );
    expect(a).not.toBe(b);
  });

  it('rejects metadata when runtime/extension fingerprint changes', () => {
    const tar = Buffer.from('valid snapshot bytes');
    const metadata = createSnapshotMetadata(tar, [migration()], schema1536, crypto);
    const changed = { ...metadata, runtimeHash: '0'.repeat(64) };
    expect(isSnapshotMetadataCompatible(changed, tar, [migration()], schema1536, crypto)).toBe(false);
  });

  it('rejects metadata from another exact PGLite package version', () => {
    const tar = Buffer.from('valid snapshot bytes');
    const metadata = createSnapshotMetadata(tar, [migration()], schema1536, crypto);
    const changed = { ...metadata, pgliteVersion: '0.0.0' };
    expect(isSnapshotMetadataCompatible(changed, tar, [migration()], schema1536, crypto)).toBe(false);
  });

  it('rejects metadata when tar bytes are corrupted', () => {
    const tar = Buffer.from('valid snapshot bytes');
    const metadata = createSnapshotMetadata(tar, [migration()], schema1536, crypto);
    expect(isSnapshotMetadataCompatible(metadata, tar, [migration()], schema1536, crypto)).toBe(true);
    expect(isSnapshotMetadataCompatible(metadata, Buffer.from('corrupt'), [migration()], schema1536, crypto)).toBe(false);
  });
});
