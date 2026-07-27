/**
 * skillpack/manifest-v1.ts — third-party skillpack.json validator.
 *
 * Third-party packs declare a `skillpack.json` at their repo root.
 * Schema is `gbrain-skillpack-v1` plus forward-compat extensions for
 * runbook + eval schema evolution.
 *
 * Shape is a SUPERSET of `BundleManifest` (bundle.ts) so the v0.36
 * scaffold + reference pipelines (which already iterate
 * `enumerateScaffoldEntries`) can consume third-party packs via the
 * adapter `bundleManifestFromSkillpack()` without forking the
 * enumeration code.
 *
 * Pure validator — no I/O beyond a single readFileSync at the entry
 * point. Throws `SkillpackManifestError` on every failure with a
 * structured code + path so the publish-gate and doctor can both
 * format actionable messages.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import type { BundleManifest } from './bundle.ts';

/** Current manifest API version. */
export const SKILLPACK_API_VERSION = 'gbrain-skillpack-v1' as const;

/** Current runbook schema version. */
export const RUNBOOK_SCHEMA_VERSION = 1 as const;

/** Current eval schema version. */
export const EVAL_SCHEMA_VERSION = 1 as const;

/** Third-party skillpack manifest. */
export interface SkillpackManifest {
  /** Forward-compat tag — installer refuses unknown values. */
  api_version: typeof SKILLPACK_API_VERSION;
  /** Package name (must match repo directory; unique in registry namespace). */
  name: string;
  /** Semver-ish version string (Keep-a-Changelog compatible). */
  version: string;
  /** One-line description, shown by `gbrain skillpack info`. */
  description: string;
  /** Author name (display name optionally with email; not parsed). */
  author: string;
  /** SPDX license id (e.g. "MIT"). */
  license: string;
  /** Homepage URL (canonical source repo). */
  homepage: string;
  /** Minimum gbrain version this pack requires (semver). */
  gbrain_min_version: string;
  /** Runbook format schema version (default 1). */
  runbook_schema_version?: number;
  /** Eval format schema version (default 1). */
  eval_schema_version?: number;

  /** Skill directories relative to pack root (e.g. ["skills/judge-submission"]). */
  skills: string[];
  /** Shared deps (files + dirs every skill in the pack depends on). */
  shared_deps?: string[];
  /** Skills bundled but not installed by default (rare; matches BundleManifest). */
  excluded_from_install?: string[];

  /** Glob(s) for unit tests run by doctor --full and publish-gate. */
  unit_tests?: string[];
  /** Glob(s) for E2E tests (skipped when no DATABASE_URL). */
  e2e_tests?: string[];
  /** Glob(s) for LLM-judge eval configs (cross-modal-eval shape). */
  llm_evals?: string[];
  /** Glob(s) for routing-eval.jsonl files. */
  routing_evals?: string[];

  /** Runbook paths the scaffolder displays post-scaffold. */
  runbooks?: {
    /** Path to bootstrap.md (per-step checklist printed after scaffold). */
    bootstrap?: string;
  };

  /** Path to CHANGELOG.md. */
  changelog?: string;

  /**
   * Marks this pack as authored for the brain/source repo it lives in.
   * Drives connect-time discovery (Topology A `sources add` advisory + the
   * `list_brain_skillpack` MCP tool) and the install nag. Absent/false = a
   * legacy or registry third-party pack. Additive + forward-compatible:
   * older gbrain ignores it; this validator tolerates it being absent.
   */
  brain_resident?: boolean;
  /**
   * The schema pack these skills assume (e.g. "gbrain-base"). When set, the
   * discovery advisory warns if it differs from the brain's active schema
   * pack so a connecting harness installs against a compatible schema.
   */
  schema_pack?: string;
}

/** Structured error code surface. */
export type SkillpackManifestErrorCode =
  | 'manifest_not_found'
  | 'manifest_malformed_json'
  | 'manifest_missing_field'
  | 'manifest_invalid_field'
  | 'manifest_unknown_api_version'
  | 'manifest_unsupported_schema_version'
  | 'manifest_skill_not_found';

export class SkillpackManifestError extends Error {
  constructor(
    message: string,
    public code: SkillpackManifestErrorCode,
    public detail?: { field?: string; expected?: string; actual?: unknown },
  ) {
    super(message);
    this.name = 'SkillpackManifestError';
  }
}

const REQUIRED_FIELDS = [
  'api_version',
  'name',
  'version',
  'description',
  'author',
  'license',
  'homepage',
  'gbrain_min_version',
  'skills',
] as const;

const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?$/;

/**
 * Validate a parsed JSON object as a SkillpackManifest. Pure function;
 * no I/O. Used by `loadSkillpackManifest` and directly by the publish-gate
 * when validating in-memory manifests.
 */
export function validateSkillpackManifest(
  raw: unknown,
  opts: { maxRunbookSchemaVersion?: number; maxEvalSchemaVersion?: number } = {},
): SkillpackManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SkillpackManifestError(
      'skillpack.json must be a JSON object at the top level',
      'manifest_malformed_json',
    );
  }
  const obj = raw as Record<string, unknown>;

  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) {
      throw new SkillpackManifestError(
        `skillpack.json is missing required field: ${field}`,
        'manifest_missing_field',
        { field },
      );
    }
  }

  if (obj.api_version !== SKILLPACK_API_VERSION) {
    throw new SkillpackManifestError(
      `skillpack.json api_version must be "${SKILLPACK_API_VERSION}"; got ${JSON.stringify(obj.api_version)}`,
      'manifest_unknown_api_version',
      { field: 'api_version', expected: SKILLPACK_API_VERSION, actual: obj.api_version },
    );
  }

  if (typeof obj.name !== 'string' || !NAME_RE.test(obj.name)) {
    throw new SkillpackManifestError(
      `name must be a lowercase kebab-case string (2-64 chars, [a-z0-9-], leading alpha); got ${JSON.stringify(obj.name)}`,
      'manifest_invalid_field',
      { field: 'name', expected: NAME_RE.source, actual: obj.name },
    );
  }

  if (typeof obj.version !== 'string' || !SEMVER_RE.test(obj.version)) {
    throw new SkillpackManifestError(
      `version must be semver shape (e.g. "0.1.0" or "0.1.0.1"); got ${JSON.stringify(obj.version)}`,
      'manifest_invalid_field',
      { field: 'version', expected: SEMVER_RE.source, actual: obj.version },
    );
  }

  for (const field of ['description', 'author', 'license', 'homepage', 'gbrain_min_version']) {
    const value = obj[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new SkillpackManifestError(
        `${field} must be a non-empty string`,
        'manifest_invalid_field',
        { field, actual: value },
      );
    }
  }

  if (typeof obj.homepage === 'string' && !/^https?:\/\//.test(obj.homepage)) {
    throw new SkillpackManifestError(
      `homepage must be an http(s) URL; got ${obj.homepage}`,
      'manifest_invalid_field',
      { field: 'homepage', actual: obj.homepage },
    );
  }

  if (!SEMVER_RE.test(obj.gbrain_min_version as string)) {
    throw new SkillpackManifestError(
      `gbrain_min_version must be semver shape (e.g. "0.36.0"); got ${JSON.stringify(obj.gbrain_min_version)}`,
      'manifest_invalid_field',
      { field: 'gbrain_min_version', expected: SEMVER_RE.source, actual: obj.gbrain_min_version },
    );
  }

  if (!Array.isArray(obj.skills) || obj.skills.length === 0) {
    throw new SkillpackManifestError(
      `skills must be a non-empty array of relative paths (e.g. ["skills/foo"])`,
      'manifest_invalid_field',
      { field: 'skills', actual: obj.skills },
    );
  }
  for (const skillPath of obj.skills) {
    if (typeof skillPath !== 'string' || !skillPath.startsWith('skills/') || skillPath.includes('..')) {
      throw new SkillpackManifestError(
        `skills entries must be relative paths starting with "skills/" and free of ".." traversal; got ${JSON.stringify(skillPath)}`,
        'manifest_invalid_field',
        { field: 'skills', actual: skillPath },
      );
    }
  }

  // Optional fields — type check only when present.
  for (const arrField of [
    'shared_deps',
    'excluded_from_install',
    'unit_tests',
    'e2e_tests',
    'llm_evals',
    'routing_evals',
  ]) {
    if (arrField in obj) {
      const v = obj[arrField];
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
        throw new SkillpackManifestError(
          `${arrField}, if present, must be an array of strings`,
          'manifest_invalid_field',
          { field: arrField, actual: v },
        );
      }
    }
  }

  if (obj.runbooks !== undefined) {
    if (typeof obj.runbooks !== 'object' || obj.runbooks === null || Array.isArray(obj.runbooks)) {
      throw new SkillpackManifestError(
        `runbooks, if present, must be an object`,
        'manifest_invalid_field',
        { field: 'runbooks', actual: obj.runbooks },
      );
    }
    const runbookObj = obj.runbooks as Record<string, unknown>;
    if (runbookObj.bootstrap !== undefined && typeof runbookObj.bootstrap !== 'string') {
      throw new SkillpackManifestError(
        `runbooks.bootstrap must be a string path`,
        'manifest_invalid_field',
        { field: 'runbooks.bootstrap', actual: runbookObj.bootstrap },
      );
    }
  }

  if (obj.changelog !== undefined && typeof obj.changelog !== 'string') {
    throw new SkillpackManifestError(
      `changelog must be a string path`,
      'manifest_invalid_field',
      { field: 'changelog', actual: obj.changelog },
    );
  }

  // Brain-resident pack fields (v0.43 — issue #2180). Both optional + additive.
  if (obj.brain_resident !== undefined && typeof obj.brain_resident !== 'boolean') {
    throw new SkillpackManifestError(
      `brain_resident, if present, must be a boolean`,
      'manifest_invalid_field',
      { field: 'brain_resident', actual: obj.brain_resident },
    );
  }
  if (obj.schema_pack !== undefined && (typeof obj.schema_pack !== 'string' || !NAME_RE.test(obj.schema_pack))) {
    throw new SkillpackManifestError(
      `schema_pack, if present, must be a lowercase kebab-case pack name; got ${JSON.stringify(obj.schema_pack)}`,
      'manifest_invalid_field',
      { field: 'schema_pack', expected: NAME_RE.source, actual: obj.schema_pack },
    );
  }

  // Schema-version forward-compat (codex outside-voice gap).
  const maxRunbook = opts.maxRunbookSchemaVersion ?? RUNBOOK_SCHEMA_VERSION;
  const maxEval = opts.maxEvalSchemaVersion ?? EVAL_SCHEMA_VERSION;
  if (obj.runbook_schema_version !== undefined) {
    const v = obj.runbook_schema_version;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      throw new SkillpackManifestError(
        `runbook_schema_version must be a positive integer`,
        'manifest_invalid_field',
        { field: 'runbook_schema_version', actual: v },
      );
    }
    if (v > maxRunbook) {
      throw new SkillpackManifestError(
        `runbook_schema_version ${v} exceeds maximum supported (${maxRunbook}). Run \`gbrain upgrade\``,
        'manifest_unsupported_schema_version',
        { field: 'runbook_schema_version', expected: `<= ${maxRunbook}`, actual: v },
      );
    }
  }
  if (obj.eval_schema_version !== undefined) {
    const v = obj.eval_schema_version;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      throw new SkillpackManifestError(
        `eval_schema_version must be a positive integer`,
        'manifest_invalid_field',
        { field: 'eval_schema_version', actual: v },
      );
    }
    if (v > maxEval) {
      throw new SkillpackManifestError(
        `eval_schema_version ${v} exceeds maximum supported (${maxEval}). Run \`gbrain upgrade\``,
        'manifest_unsupported_schema_version',
        { field: 'eval_schema_version', expected: `<= ${maxEval}`, actual: v },
      );
    }
  }

  return obj as unknown as SkillpackManifest;
}

/**
 * Load + validate `skillpack.json` from a pack root. Throws
 * `SkillpackManifestError` on missing file, malformed JSON, schema violation,
 * unknown api_version, or skill directory missing on disk.
 */
export function loadSkillpackManifest(packRoot: string): SkillpackManifest {
  const manifestPath = join(packRoot, 'skillpack.json');
  if (!existsSync(manifestPath)) {
    throw new SkillpackManifestError(
      `skillpack.json not found at ${manifestPath}`,
      'manifest_not_found',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    throw new SkillpackManifestError(
      `skillpack.json is not valid JSON: ${(err as Error).message}`,
      'manifest_malformed_json',
    );
  }

  const manifest = validateSkillpackManifest(raw);

  // Verify every declared skill directory exists on disk.
  for (const skillPath of manifest.skills) {
    const abs = join(packRoot, skillPath);
    if (!existsSync(abs)) {
      throw new SkillpackManifestError(
        `skillpack.json declares skill "${skillPath}" but ${abs} does not exist`,
        'manifest_skill_not_found',
        { field: 'skills', actual: skillPath },
      );
    }
  }

  return manifest;
}

/**
 * Adapter: project a SkillpackManifest onto the existing BundleManifest
 * shape so v0.36's `enumerateScaffoldEntries` + `loadSkillSources` paths
 * iterate third-party packs without any changes. The third-party fields
 * (unit_tests, llm_evals, runbooks, etc.) live on SkillpackManifest only;
 * the bundle iteration doesn't need them.
 */
export function bundleManifestFromSkillpack(pack: SkillpackManifest): BundleManifest {
  return {
    name: pack.name,
    version: pack.version,
    description: pack.description,
    skills: pack.skills,
    shared_deps: pack.shared_deps ?? [],
    excluded_from_install: pack.excluded_from_install,
  };
}
