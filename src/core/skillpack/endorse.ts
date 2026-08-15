/**
 * skillpack/endorse.ts — Garry-only endorsement workflow for the registry.
 *
 * Operator runs `gbrain skillpack endorse <name> [--tier T]` inside a clone
 * of `garrytan/gbrain-skillpack-registry`. The CLI:
 *   1. Validates `<name>` exists in registry.json
 *   2. Reads + schema-validates endorsements.json
 *   3. Sets/clears the tier entry (community → endorsed is the common path)
 *   4. Writes back with stable key ordering so diffs are clean
 *   5. Stages + creates a one-line commit `endorse: <name> -> <tier>`
 *   6. Optionally pushes (--push)
 *
 * Pure-data shape lives here; the CLI wrapper in src/commands/skillpack.ts
 * handles user-facing argv parsing + git invocations.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  ENDORSEMENTS_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION,
  RegistrySchemaError,
  validateEndorsementsFile,
  validateRegistryCatalog,
  type EndorsementsFile,
  type RegistryTier,
} from './registry-schema.ts';

export interface EndorseOptions {
  /** Absolute path to a clone of the registry repo. */
  registryRepoRoot: string;
  /** Pack name to endorse / change tier on. */
  packName: string;
  /** Target tier. Defaults to 'endorsed' since that's the common move. */
  tier?: RegistryTier;
  /** Optional human note recorded alongside the endorsement. */
  note?: string;
  /** Dry-run: report what would change without writing or committing. */
  dryRun?: boolean;
  /** Push the commit to origin/main after writing. */
  push?: boolean;
}

export interface EndorseResult {
  schema_version: 'skillpack-endorse-v1';
  pack_name: string;
  prior_tier: RegistryTier | null;
  new_tier: RegistryTier;
  endorsements_path: string;
  commit_sha: string | null;
  pushed: boolean;
  dry_run: boolean;
}

export type EndorseErrorCode =
  | 'not_a_registry_repo'
  | 'pack_not_in_catalog'
  | 'git_commit_failed'
  | 'git_push_failed';

export class EndorseError extends Error {
  constructor(
    message: string,
    public code: EndorseErrorCode,
  ) {
    super(message);
    this.name = 'EndorseError';
  }
}

/** Verify the directory looks like a skillpack-registry repo. */
function assertRegistryRepo(root: string): void {
  const reg = join(root, 'registry.json');
  if (!existsSync(reg)) {
    throw new EndorseError(
      `${root} does not look like a skillpack-registry repo (no registry.json at root)`,
      'not_a_registry_repo',
    );
  }
  try {
    const raw = JSON.parse(readFileSync(reg, 'utf-8'));
    validateRegistryCatalog(raw);
  } catch (err) {
    if (err instanceof RegistrySchemaError) {
      throw new EndorseError(
        `${root}/registry.json is malformed: ${err.message}`,
        'not_a_registry_repo',
      );
    }
    throw err;
  }
}

/** Stable JSON.stringify with sorted keys at every depth. */
function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(value, sortReplacer, indent) + '\n';
}

function sortReplacer(_key: string, val: unknown): unknown {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) return val;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[k] = (val as Record<string, unknown>)[k];
  }
  return sorted;
}

/** Pure-fn that mutates the parsed endorsements object. */
export function applyEndorsement(
  current: EndorsementsFile,
  packName: string,
  tier: RegistryTier,
  note?: string,
): { next: EndorsementsFile; prior_tier: RegistryTier | null } {
  const prior = current.endorsements[packName]?.tier ?? null;
  const next: EndorsementsFile = {
    schema_version: ENDORSEMENTS_SCHEMA_VERSION,
    endorsements: {
      ...current.endorsements,
      [packName]: {
        tier,
        endorsed_at: new Date().toISOString(),
        ...(note ? { note } : {}),
      },
    },
  };
  return { next, prior_tier: prior };
}

/**
 * Run the full endorse flow: validate -> mutate -> write atomically ->
 * git stage + commit -> optionally push. Returns a structured result the
 * CLI formats.
 */
export function runEndorse(opts: EndorseOptions): EndorseResult {
  assertRegistryRepo(opts.registryRepoRoot);

  // Catalog membership check.
  const catalogRaw = JSON.parse(readFileSync(join(opts.registryRepoRoot, 'registry.json'), 'utf-8'));
  const catalog = validateRegistryCatalog(catalogRaw);
  if (!catalog.skillpacks.some((e) => e.name === opts.packName)) {
    throw new EndorseError(
      `pack "${opts.packName}" is not in registry.json — endorse requires a catalog entry first`,
      'pack_not_in_catalog',
    );
  }

  // Endorsements file (may be missing on a fresh registry).
  const endPath = join(opts.registryRepoRoot, 'endorsements.json');
  let current: EndorsementsFile;
  if (existsSync(endPath)) {
    current = validateEndorsementsFile(JSON.parse(readFileSync(endPath, 'utf-8')));
  } else {
    current = { schema_version: ENDORSEMENTS_SCHEMA_VERSION, endorsements: {} };
  }

  const tier = opts.tier ?? 'endorsed';
  const { next, prior_tier } = applyEndorsement(current, opts.packName, tier, opts.note);

  if (opts.dryRun) {
    return {
      schema_version: 'skillpack-endorse-v1',
      pack_name: opts.packName,
      prior_tier,
      new_tier: tier,
      endorsements_path: endPath,
      commit_sha: null,
      pushed: false,
      dry_run: true,
    };
  }

  // Atomic write via .tmp + rename.
  const tmp = endPath + '.tmp';
  writeFileSync(tmp, stableStringify(next));
  renameSync(tmp, endPath);

  // git stage + commit.
  let commitSha: string | null = null;
  try {
    execFileSync('git', ['-C', opts.registryRepoRoot, 'add', 'endorsements.json'], {
      encoding: 'utf-8',
    });
    execFileSync(
      'git',
      ['-C', opts.registryRepoRoot, 'commit', '-m', `endorse: ${opts.packName} -> ${tier}`],
      { encoding: 'utf-8' },
    );
    commitSha = execFileSync('git', ['-C', opts.registryRepoRoot, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
    }).trim();
  } catch (err) {
    throw new EndorseError(
      `git commit failed: ${(err as Error).message}`,
      'git_commit_failed',
    );
  }

  let pushed = false;
  if (opts.push) {
    try {
      execFileSync('git', ['-C', opts.registryRepoRoot, 'push', 'origin', 'HEAD'], {
        encoding: 'utf-8',
      });
      pushed = true;
    } catch (err) {
      throw new EndorseError(
        `git push failed: ${(err as Error).message}`,
        'git_push_failed',
      );
    }
  }

  return {
    schema_version: 'skillpack-endorse-v1',
    pack_name: opts.packName,
    prior_tier,
    new_tier: tier,
    endorsements_path: endPath,
    commit_sha: commitSha,
    pushed,
    dry_run: false,
  };
}
