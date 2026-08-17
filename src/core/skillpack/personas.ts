/**
 * skillpack/personas.ts — persona curation over skills/plugin-lanes.json.
 *
 * A persona is a named, reasoned subset of the plugin LANE set (the lane =
 * openclaw.plugin.json#skills minus base_exclusions plus additions — the
 * same algebra scripts/generate-plugin-tree.ts enforces). Personas drive
 * two consumers with ONE implementation:
 *   - the harness bridge (`gbrain skillpack scaffold` with a harness) picks
 *     its default install set from a persona;
 *   - scripts/generate-plugin-tree.ts emits a plugin-variants/<plugin_name>/
 *     tree per persona and validates the block in CI.
 * The generator IMPORTS this module (no mirrored validation) so CLI errors
 * and CI errors are identical by construction [CEO-F6].
 *
 * Validation universe: persona membership must be ⊆ the lane set — which
 * transitively excludes base_exclusions (`testing` et al, recorded as
 * "meaningless-to-harmful in a plugin snapshot"). Path RESOLUTION for the
 * bridge happens elsewhere against skills/manifest.json (bundle.ts
 * universe 'manifest') because 6 of the 8 lane additions are not listed in
 * openclaw.plugin.json#skills.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { loadBundleManifest, pathSlug } from './bundle.ts';

export const RESERVED_PERSONA_NAMES = ['all'] as const;

export interface PersonaDef {
  /** Human description of who this persona serves (≥10 chars). */
  description: string;
  /** Marketplace/plugin identity for the generated variant tree —
   *  `gbrain-` prefixed, unique across personas (e.g. `gbrain-coding`). */
  plugin_name: string;
  /** slug → recorded publication reason (≥10 chars), same convention as
   *  plugin-lanes additions/base_exclusions. */
  skills: Record<string, string>;
}

export interface PersonasLoadResult {
  /** Validated personas (empty object when the block is absent). */
  personas: Record<string, PersonaDef>;
  /** The lane set the personas were validated against. */
  laneSet: Set<string>;
}

export type PersonaErrorCode =
  | 'lanes_not_found'
  | 'lanes_malformed'
  | 'persona_invalid'
  | 'persona_unknown'
  | 'slug_not_in_lane';

export class PersonaError extends Error {
  constructor(
    message: string,
    public code: PersonaErrorCode,
  ) {
    super(message);
    this.name = 'PersonaError';
  }
}

function lanesPath(gbrainRoot: string): string {
  // gbrainRoot is the detected gbrain repo root joined with literals, on the
  // local CLI/build plane — no untrusted input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return join(gbrainRoot, 'skills', 'plugin-lanes.json');
}

interface RawLanes {
  additions?: Record<string, string>;
  base_exclusions?: Record<string, string>;
  personas?: Record<string, unknown>;
}

function loadLanesRaw(gbrainRoot: string): RawLanes {
  const p = lanesPath(gbrainRoot);
  if (!existsSync(p)) {
    throw new PersonaError(`skills/plugin-lanes.json not found in ${gbrainRoot}`, 'lanes_not_found');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf-8'));
  } catch (err) {
    throw new PersonaError(
      `skills/plugin-lanes.json: invalid JSON — ${(err as Error).message}`,
      'lanes_malformed',
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PersonaError('skills/plugin-lanes.json: top level must be an object', 'lanes_malformed');
  }
  return parsed as RawLanes;
}

/**
 * The plugin lane set: (openclaw.plugin.json#skills slugs ∖ base_exclusions)
 * ∪ additions. Mirrors scripts/generate-plugin-tree.ts's lane algebra.
 */
export function computeLaneSet(gbrainRoot: string): Set<string> {
  const lanes = loadLanesRaw(gbrainRoot);
  const manifest = loadBundleManifest(gbrainRoot);
  const lane = new Set(manifest.skills.map(p => pathSlug(p)));
  for (const slug of Object.keys(lanes.base_exclusions ?? {})) lane.delete(slug);
  for (const slug of Object.keys(lanes.additions ?? {})) lane.add(slug);
  return lane;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLUGIN_NAME = /^gbrain-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_REASON = 10;

/**
 * Load + validate the personas block. Fail-loud (PersonaError) on any rule
 * violation; an ABSENT block is valid and yields `{}` (personas are
 * optional until curated).
 *
 * Rules (enforced identically for the CLI and the generator):
 *   - persona name: kebab-case, not a reserved name (`all`);
 *   - description: string, ≥10 chars;
 *   - plugin_name: `gbrain-` prefixed kebab, unique across personas;
 *   - skills: non-empty object of slug → reason (≥10 chars);
 *   - every slug ∈ lane set (transitively rejects base_exclusions).
 */
export function loadPersonas(gbrainRoot: string): PersonasLoadResult {
  const lanes = loadLanesRaw(gbrainRoot);
  const laneSet = computeLaneSet(gbrainRoot);
  const raw = lanes.personas;
  if (raw === undefined) return { personas: {}, laneSet };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PersonaError('plugin-lanes.json#personas must be an object', 'persona_invalid');
  }

  const personas: Record<string, PersonaDef> = {};
  const seenPluginNames = new Map<string, string>();
  for (const [name, defRaw] of Object.entries(raw)) {
    if (!KEBAB.test(name)) {
      throw new PersonaError(`persona '${name}': name must be kebab-case`, 'persona_invalid');
    }
    if ((RESERVED_PERSONA_NAMES as readonly string[]).includes(name)) {
      throw new PersonaError(
        `persona '${name}': reserved name ('all' means the full lane set)`,
        'persona_invalid',
      );
    }
    if (typeof defRaw !== 'object' || defRaw === null || Array.isArray(defRaw)) {
      throw new PersonaError(`persona '${name}': must be an object`, 'persona_invalid');
    }
    const def = defRaw as Partial<PersonaDef>;
    if (typeof def.description !== 'string' || def.description.trim().length < MIN_REASON) {
      throw new PersonaError(
        `persona '${name}': description must be a string of at least ${MIN_REASON} chars`,
        'persona_invalid',
      );
    }
    if (typeof def.plugin_name !== 'string' || !PLUGIN_NAME.test(def.plugin_name)) {
      throw new PersonaError(
        `persona '${name}': plugin_name must match gbrain-<kebab> (got ${JSON.stringify(def.plugin_name)})`,
        'persona_invalid',
      );
    }
    const prior = seenPluginNames.get(def.plugin_name);
    if (prior) {
      throw new PersonaError(
        `persona '${name}': plugin_name '${def.plugin_name}' already used by persona '${prior}'`,
        'persona_invalid',
      );
    }
    seenPluginNames.set(def.plugin_name, name);
    if (
      typeof def.skills !== 'object' ||
      def.skills === null ||
      Array.isArray(def.skills) ||
      Object.keys(def.skills).length === 0
    ) {
      throw new PersonaError(
        `persona '${name}': skills must be a non-empty object of slug → reason`,
        'persona_invalid',
      );
    }
    for (const [slug, reason] of Object.entries(def.skills)) {
      if (typeof reason !== 'string' || reason.trim().length < MIN_REASON) {
        throw new PersonaError(
          `persona '${name}': skill '${slug}' needs a recorded reason of at least ${MIN_REASON} chars`,
          'persona_invalid',
        );
      }
      if (!laneSet.has(slug)) {
        throw new PersonaError(
          `persona '${name}': skill '${slug}' is not in the plugin lane set ` +
            `(lane = openclaw.plugin.json#skills minus base_exclusions plus additions). ` +
            `Lane-excluded and unknown slugs cannot join a persona.`,
          'slug_not_in_lane',
        );
      }
    }
    personas[name] = {
      description: def.description,
      plugin_name: def.plugin_name,
      skills: { ...def.skills },
    };
  }
  return { personas, laneSet };
}

/**
 * Resolve a persona name (or 'all') to its sorted slug list. 'all' = the
 * full lane set. Unknown personas fail loudly naming the valid choices.
 */
export function resolvePersonaSlugs(gbrainRoot: string, persona: string): string[] {
  const { personas, laneSet } = loadPersonas(gbrainRoot);
  if (persona === 'all') return [...laneSet].sort();
  const def = personas[persona];
  if (!def) {
    const valid = Object.keys(personas);
    throw new PersonaError(
      `unknown persona '${persona}'. Valid: ${valid.length > 0 ? valid.join(', ') : '(none defined)'} — or 'all' for the full lane set.`,
      'persona_unknown',
    );
  }
  return Object.keys(def.skills).sort();
}

/**
 * Validate explicit slug picks (the CLI's per-skill override) against the
 * lane set. The lane — not skills/manifest.json — is the validation
 * universe, so lane-excluded skills are refused WITH their recorded reason.
 */
export function validateSlugsAgainstLane(gbrainRoot: string, slugs: readonly string[]): void {
  const lanes = loadLanesRaw(gbrainRoot);
  const laneSet = computeLaneSet(gbrainRoot);
  const exclusions = lanes.base_exclusions ?? {};
  for (const slug of slugs) {
    if (laneSet.has(slug)) continue;
    const reason = exclusions[slug];
    if (reason) {
      throw new PersonaError(
        `skill '${slug}' is excluded from the plugin lane: ${reason}`,
        'slug_not_in_lane',
      );
    }
    throw new PersonaError(
      `skill '${slug}' is not in the plugin lane set (unknown or not published to the lane).`,
      'slug_not_in_lane',
    );
  }
}
