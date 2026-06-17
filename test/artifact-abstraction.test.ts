// v0.39 T14 — artifact abstraction unit test.
// Pins detectArtifactKind dispatch + targetDirForKind + manifest validation
// so the cross-discriminator surface stays MECE.

import { describe, test, expect } from 'bun:test';
import {
  detectArtifactKind,
  targetDirForKind,
  validateManifestByKind,
} from '../src/core/artifact/index.ts';

describe('v0.39 T14 — artifact abstraction', () => {
  test('detectArtifactKind by extension', () => {
    expect(detectArtifactKind('/tmp/foo.gbrain-schema')).toBe('schemapack');
    expect(detectArtifactKind('/tmp/foo.gbrain-skillpack')).toBe('skillpack');
    expect(detectArtifactKind('/tmp/foo.tar.gz')).toBe(null);
  });

  test('targetDirForKind routes to distinct subdirectories', () => {
    expect(targetDirForKind('schemapack', '/home/u/.gbrain')).toBe('/home/u/.gbrain/schema-packs');
    expect(targetDirForKind('skillpack', '/home/u/.gbrain')).toBe('/home/u/.gbrain/skillpacks');
  });

  test('validateManifestByKind: schemapack happy path', () => {
    expect(() => validateManifestByKind('schemapack', { api_version: 'gbrain-schema-pack-v1' })).not.toThrow();
  });

  test('validateManifestByKind: skillpack happy path', () => {
    expect(() => validateManifestByKind('skillpack', { api_version: 'gbrain-skillpack-v1' })).not.toThrow();
  });

  test('validateManifestByKind: rejects wrong api_version', () => {
    expect(() => validateManifestByKind('schemapack', { api_version: 'gbrain-skillpack-v1' })).toThrow(/api_version/);
    expect(() => validateManifestByKind('skillpack', { api_version: 'gbrain-schema-pack-v1' })).toThrow(/api_version/);
  });

  test('validateManifestByKind: rejects non-object', () => {
    expect(() => validateManifestByKind('schemapack', null)).toThrow();
    expect(() => validateManifestByKind('skillpack', 'string')).toThrow();
  });
});
