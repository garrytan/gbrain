/**
 * SlugRegistry — slug-creation with collision detection.
 *
 * Wraps engine.resolveSlugs to answer "does slug X already exist?" and,
 * when a desired slug collides with a different entity, returns a
 * disambiguated alternative (alice-smith-2, alice-smith-3, ...) or merges
 * the two when the caller confirms they're the same entity.
 *
 * Built around a real pain: today `slugify(name)` is a pure function with
 * no database lookup, so "Marc Benioff" and "Marc Benioff (with hyphen)"
 * both produce `marc-benioff` and silently overwrite each other.
 *
 * v1 scope: detect collisions at create time, append numeric disambiguator,
 * expose merge() for after-the-fact de-dup. Auto-heuristic merging (email
 * match, x_handle match) is PR 2.5+.
 */

import type { BrainEngine } from '../engine.ts';
import type { PageType } from '../types.ts';

export interface CreateSlugInput {
  /**
   * Desired slug in dir/name form, e.g. "people/alice-smith".
   * If it's already taken, we append a disambiguator.
   */
  desiredSlug: string;
  /** Display name the user sees (for error messages). */
  displayName: string;
  /** Entity type — used to scope conflict detection to the same dir. */
  type: PageType;
  /**
   * Disambiguator strategy when there's a collision:
   *   - 'append-numeric' (default): alice-smith → alice-smith-2
   *   - 'throw': raise SlugCollision so caller handles it explicitly
   */
  onCollision?: 'append-numeric' | 'throw';
  /**
   * Max disambiguator suffix before giving up. Default 50 (alice-smith-50
   * would be absurd). Caller should surface a human-readable error above
   * this threshold.
   */
  maxDisambiguator?: number;
}

export interface CreatedSlug {
  slug: string;
  /** True if we returned the exact desiredSlug; false if we disambiguated. */
  exact: boolean;
  /** If disambiguated, the number we appended. */
  disambiguator?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SlugRegistryErrorCode = 'collision' | 'disambiguator_exhausted' | 'invalid_slug';

export class SlugRegistryError extends Error {
  constructor(
    public code: SlugRegistryErrorCode,
    message: string,
    public slug?: string,
  ) {
    super(message);
    this.name = 'SlugRegistryError';
  }
}

// ---------------------------------------------------------------------------
// SlugRegistry
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9\-]*(\/[a-z0-9][a-z0-9\-]*)+$/;

export class SlugRegistry {
  constructor(private engine: BrainEngine) {}

  /**
   * Create a new slug, or disambiguate if taken. Checks engine.getPage(slug)
   * to detect collisions. Caller must pass the SAME engine instance used by
   * BrainWriter to avoid racey reads.
   */
  async create(input: CreateSlugInput): Promise<CreatedSlug> {
    const { desiredSlug, displayName, onCollision = 'append-numeric', maxDisambiguator = 50 } = input;

    if (!SLUG_RE.test(desiredSlug)) {
      throw new SlugRegistryError('invalid_slug', `Invalid slug: ${desiredSlug} (expect dir/name form)`, desiredSlug);
    }

    // Fast path: desired is free
    const existing = await this.engine.getPage(desiredSlug);
    if (!existing) {
      return { slug: desiredSlug, exact: true };
    }

    // Collision
    if (onCollision === 'throw') {
      throw new SlugRegistryError(
        'collision',
        `Slug already exists: ${desiredSlug} (for "${displayName}")`,
        desiredSlug,
      );
    }

    // append-numeric disambiguation: start at 2 (matches "alice-smith" → "alice-smith-2")
    for (let n = 2; n <= maxDisambiguator; n++) {
      const candidate = `${desiredSlug}-${n}`;
      const conflict = await this.engine.getPage(candidate);
      if (!conflict) {
        return { slug: candidate, exact: false, disambiguator: n };
      }
    }

    throw new SlugRegistryError(
      'disambiguator_exhausted',
      `Exhausted disambiguator for ${desiredSlug} after ${maxDisambiguator} attempts. Likely indicates runaway duplicate creation.`,
      desiredSlug,
    );
  }

  /**
   * Probe whether a slug is free, without creating anything. Useful for
   * pre-flight checks in interactive flows.
   */
  async isFree(slug: string): Promise<boolean> {
    if (!SLUG_RE.test(slug)) return false;
    const existing = await this.engine.getPage(slug);
    return !existing;
  }

  /**
   * Suggest up to N disambiguator candidates for a slug, without taking any.
   * Caller renders them in a CLI prompt, user picks one. Used by
   * `gbrain integrity --auto` when it finds two entities that slug-match
   * but aren't obviously the same person.
   */
  async suggestDisambiguators(desiredSlug: string, n = 3): Promise<string[]> {
    if (!SLUG_RE.test(desiredSlug)) return [];
    const out: string[] = [];
    for (let i = 2; i <= 2 + 20 && out.length < n; i++) {
      const candidate = `${desiredSlug}-${i}`;
      if (await this.isFree(candidate)) out.push(candidate);
    }
    return out;
  }
}
