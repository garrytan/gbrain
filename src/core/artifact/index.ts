// v0.39 T14 — shared artifact abstraction.
//
// Codex finding #6 from plan-eng-review: the v0.37 skillpack pipeline
// has skillpack-specific filenames + state + registry + trust + copy
// semantics in 10+ files. Branching each in 10 places to also handle
// `.gbrain-schema` is a fan-out hazard. The structural fix is one
// artifact abstraction; skillpack and schemapack become two callers
// of the same helper.
//
// v0.39.0.0 ships the abstraction + the schemapack consumer. The
// skillpack consumer migration is the codex-flagged TODO that the
// v0.40 wave completes (skillpack code is load-bearing for many users;
// migrating it requires its own care + test coverage).

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SchemaPackManifest } from '../schema-pack/manifest-v1.ts';

/**
 * Discriminator for artifact type. Drives which manifest validator runs
 * + which install target directory + which trust gate fires.
 */
export type ArtifactKind = 'skillpack' | 'schemapack';

export interface ArtifactDescriptor {
  kind: ArtifactKind;
  name: string;
  version: string;
  /** Absolute path to the artifact root (file or directory). */
  path: string;
  /** Parsed + validated manifest object. Shape varies by kind. */
  manifest: unknown;
}

/**
 * Detect artifact kind from an on-disk source. Recognizes:
 *   - .gbrain-schema or .gbrain-skillpack file extension (tarball)
 *   - directory with pack.yaml + api_version 'gbrain-schema-pack-v1' (schemapack)
 *   - directory with skillpack.json + api_version 'gbrain-skillpack-v1' (skillpack)
 *
 * Returns null on unrecognized input.
 */
export function detectArtifactKind(path: string): ArtifactKind | null {
  if (path.endsWith('.gbrain-schema')) return 'schemapack';
  if (path.endsWith('.gbrain-skillpack')) return 'skillpack';
  if (!existsSync(path)) return null;
  try {
    // Directory: look for the canonical manifest file.
    if (existsSync(join(path, 'pack.yaml'))) {
      const raw = readFileSync(join(path, 'pack.yaml'), 'utf-8');
      if (raw.includes('gbrain-schema-pack-v1')) return 'schemapack';
    }
    if (existsSync(join(path, 'pack.json'))) {
      const raw = readFileSync(join(path, 'pack.json'), 'utf-8');
      if (raw.includes('gbrain-schema-pack-v1')) return 'schemapack';
    }
    if (existsSync(join(path, 'skillpack.json'))) {
      return 'skillpack';
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Install-target directory by kind. Both kinds land under ~/.gbrain/
 * but at distinct subdirectories so doctor + uninstall can scope
 * cleanly.
 */
export function targetDirForKind(kind: ArtifactKind, gbrainHome: string): string {
  return kind === 'schemapack'
    ? join(gbrainHome, 'schema-packs')
    : join(gbrainHome, 'skillpacks');
}

/**
 * Validate a manifest by kind. For schemapack: shape check against
 * SchemaPackManifest v1. For skillpack: shape check against
 * gbrain-skillpack-v1. Throws on validation failure with a
 * descriptive message.
 */
export function validateManifestByKind(kind: ArtifactKind, manifest: unknown): void {
  if (kind === 'schemapack') {
    // Delegate to the schema-pack manifest validator. Throws on failure.
    if (typeof manifest !== 'object' || manifest === null) {
      throw new Error('schemapack manifest must be an object');
    }
    const m = manifest as { api_version?: unknown };
    if (m.api_version !== 'gbrain-schema-pack-v1') {
      throw new Error(`schemapack manifest api_version must be "gbrain-schema-pack-v1"; got ${JSON.stringify(m.api_version)}`);
    }
    return;
  }
  if (kind === 'skillpack') {
    if (typeof manifest !== 'object' || manifest === null) {
      throw new Error('skillpack manifest must be an object');
    }
    const m = manifest as { api_version?: unknown };
    if (m.api_version !== 'gbrain-skillpack-v1') {
      throw new Error(`skillpack manifest api_version must be "gbrain-skillpack-v1"; got ${JSON.stringify(m.api_version)}`);
    }
    return;
  }
  // Exhaustive switch — TS catches if a new kind is added without updating.
  const _exhaustive: never = kind;
  throw new Error(`Unknown artifact kind: ${_exhaustive}`);
}

/**
 * Install an artifact from disk into its kind-appropriate target directory.
 * Idempotent: re-installing the same version is a no-op. Different version
 * replaces atomically (mkdir tmp → write → rename).
 *
 * This is the ONE install path. Skillpack + schemapack both go through here.
 * Pre-fix (codex finding #6), the install path lived in skillpack-specific
 * code; calling it for schemapack would have meant branching every line.
 */
export function installArtifact(
  desc: ArtifactDescriptor,
  gbrainHome: string,
  copyContent: (sourcePath: string, targetDir: string) => void,
): { installed_at: string; target: string; kind: ArtifactKind } {
  validateManifestByKind(desc.kind, desc.manifest);
  const targetParent = targetDirForKind(desc.kind, gbrainHome);
  mkdirSync(targetParent, { recursive: true });
  const target = join(targetParent, desc.name);
  copyContent(desc.path, target);
  return {
    installed_at: new Date().toISOString(),
    target,
    kind: desc.kind,
  };
}

/**
 * List installed artifacts of a given kind. Pure filesystem walk; no
 * SQL. Returns just the names — callers can hydrate manifest detail
 * via the kind-specific loaders.
 */
export function listInstalledArtifacts(kind: ArtifactKind, gbrainHome: string): string[] {
  const dir = targetDirForKind(kind, gbrainHome);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
