/**
 * skillpack/pack-publish.ts — `gbrain skillpack pack` orchestrator.
 *
 * Runs the publisher's local validation + deterministic tarball emit:
 *   1. runDoctor(--quick) over the pack root; refuse if tier_eligibility
 *      is `blocked` (any core dim failing).
 *   2. packTarball into <out>/<name>-<version>.tgz with deterministic
 *      flags. Computes + reports SHA-256.
 *   3. Returns a structured result the CLI consumes.
 *
 * --dry-run runs the doctor only and skips the tarball step. --skip-doctor
 * is the escape hatch for the publish-gate skill which already runs the
 * doctor server-side. Validation results are persisted into the audit
 * log so the publish-gate skill can read the local-run history.
 */

import { mkdirSync } from 'fs';
import { join } from 'path';

import { logSkillpackEvent } from './audit.ts';
import { runDoctor, type DoctorResult } from './doctor.ts';
import { loadSkillpackManifest } from './manifest-v1.ts';
import { packTarball, type TarballPackResult } from './tarball.ts';

export interface PackPublishOptions {
  /** Absolute path to the pack root. */
  packRoot: string;
  /** Output directory for the tarball (default: <packRoot>). */
  outDir?: string;
  /** Skip the doctor gate (publish-gate skill uses this; the gate runs server-side). */
  skipDoctor?: boolean;
  /** Dry-run: validate only, no tarball. */
  dryRun?: boolean;
}

export interface PackPublishResult {
  schema_version: 'skillpack-pack-v1';
  pack_name: string;
  pack_version: string;
  doctor: DoctorResult | null;
  tarball: (TarballPackResult & { tier_eligibility: string }) | null;
  refused_reason: string | null;
}

export class PackPublishError extends Error {
  constructor(
    message: string,
    public code: 'doctor_blocked' | 'manifest_load_failed' | 'pack_failed',
  ) {
    super(message);
    this.name = 'PackPublishError';
  }
}

export async function runPackPublish(opts: PackPublishOptions): Promise<PackPublishResult> {
  let manifest;
  try {
    manifest = loadSkillpackManifest(opts.packRoot);
  } catch (err) {
    throw new PackPublishError(
      `Failed to load skillpack.json: ${(err as Error).message}`,
      'manifest_load_failed',
    );
  }

  let doctor: DoctorResult | null = null;
  if (!opts.skipDoctor) {
    doctor = await runDoctor({ packRoot: opts.packRoot, mode: 'quick' });
    if (doctor.tier_eligibility === 'blocked') {
      // Audit the refusal.
      logSkillpackEvent({
        event: 'doctor_run',
        pack: manifest.name,
        version: manifest.version,
        outcome: 'error',
        error: `pack refused: ${doctor.promotion_blockers.join(', ')}`,
        meta: { mode: 'pack-publish-gate', score: doctor.score },
      });
      return {
        schema_version: 'skillpack-pack-v1',
        pack_name: manifest.name,
        pack_version: manifest.version,
        doctor,
        tarball: null,
        refused_reason: `doctor blocked: ${doctor.promotion_blockers.join(', ')}`,
      };
    }
  }

  if (opts.dryRun) {
    return {
      schema_version: 'skillpack-pack-v1',
      pack_name: manifest.name,
      pack_version: manifest.version,
      doctor,
      tarball: null,
      refused_reason: null,
    };
  }

  // Pack tarball into <outDir>/<name>-<version>.tgz.
  const outDir = opts.outDir ?? opts.packRoot;
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${manifest.name}-${manifest.version}.tgz`);

  let tarball: TarballPackResult;
  try {
    tarball = packTarball({
      sourceDir: opts.packRoot,
      outPath,
      exclude: ['node_modules', '.git', '.DS_Store', '*.tgz'],
    });
  } catch (err) {
    throw new PackPublishError(
      `tarball pack failed: ${(err as Error).message}`,
      'pack_failed',
    );
  }

  logSkillpackEvent({
    event: 'doctor_run',
    pack: manifest.name,
    version: manifest.version,
    outcome: 'ok',
    meta: {
      mode: 'pack-publish-gate',
      score: doctor?.score ?? null,
      tier: doctor?.tier_eligibility ?? null,
      tarball_sha256: tarball.sha256,
    },
  });

  return {
    schema_version: 'skillpack-pack-v1',
    pack_name: manifest.name,
    pack_version: manifest.version,
    doctor,
    tarball: { ...tarball, tier_eligibility: doctor?.tier_eligibility ?? 'unknown' },
    refused_reason: null,
  };
}
