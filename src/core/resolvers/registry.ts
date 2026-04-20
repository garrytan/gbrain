/**
 * ResolverRegistry — in-memory map from id → Resolver<I, O>.
 *
 * Single source of truth for resolver lookup. Wired at boot in each CLI
 * entry point (or test setUp) via register(). Consumers call resolve(id,
 * input, ctx) rather than importing individual resolvers directly, so the
 * set of available resolvers can grow via plugins later without touching
 * every caller.
 *
 * This file is intentionally dependency-free beyond ./interface — keep it
 * that way so it can be unit-tested without mocking engine/storage.
 */

import type {
  Resolver,
  ResolverContext,
  ResolverCost,
  ResolverResult,
} from './interface.ts';
import { ResolverError } from './interface.ts';

export interface ResolverListFilter {
  cost?: ResolverCost;
  backend?: string;
}

/**
 * Summary shape returned by list(). Same data as the Resolver but without
 * the resolve()/available() methods — suitable for `gbrain resolvers list`
 * and plugin-discovery UX.
 */
export interface ResolverSummary {
  id: string;
  cost: ResolverCost;
  backend: string;
  description?: string;
  hasInputSchema: boolean;
  hasOutputSchema: boolean;
}

export class ResolverRegistry {
  private resolvers = new Map<string, Resolver<unknown, unknown>>();

  /**
   * Register a resolver. Throws if the id is already taken — catches
   * copy-paste bugs early.
   */
  register<I, O>(resolver: Resolver<I, O>): void {
    if (!resolver.id || typeof resolver.id !== 'string') {
      throw new ResolverError('schema', 'Resolver.id must be a non-empty string');
    }
    if (this.resolvers.has(resolver.id)) {
      throw new ResolverError(
        'already_registered',
        `Resolver '${resolver.id}' is already registered`,
        resolver.id,
      );
    }
    this.resolvers.set(resolver.id, resolver as Resolver<unknown, unknown>);
  }

  /** Return the resolver for id, or throw ResolverError(not_found). */
  get(id: string): Resolver<unknown, unknown> {
    const r = this.resolvers.get(id);
    if (!r) {
      throw new ResolverError('not_found', `Resolver '${id}' not found`, id);
    }
    return r;
  }

  has(id: string): boolean {
    return this.resolvers.has(id);
  }

  /** List all resolvers, optionally filtered by cost or backend. */
  list(filter?: ResolverListFilter): ResolverSummary[] {
    let all: Resolver<unknown, unknown>[] = [...this.resolvers.values()];
    if (filter?.cost) all = all.filter(r => r.cost === filter.cost);
    if (filter?.backend) all = all.filter(r => r.backend === filter.backend);
    return all.map(toSummary).sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Resolve an input through the given resolver id. This is the main entry
   * point for callers — they never instantiate a Resolver directly.
   *
   * Flow:
   *   1. Look up resolver by id (throw not_found).
   *   2. Call available(ctx) (throw unavailable if false).
   *   3. Call resolve() (propagates ResolverError subcodes from the resolver).
   *
   * Does NOT wrap in FailImproveLoop or AbortSignal handling — those are
   * concerns of the individual resolver implementation (or the later
   * ResolverFailImprove wrapper).
   */
  async resolve<I, O>(
    id: string,
    input: I,
    ctx: ResolverContext,
    opts?: { timeoutMs?: number },
  ): Promise<ResolverResult<O>> {
    const resolver = this.get(id) as Resolver<I, O>;
    const ok = await resolver.available(ctx);
    if (!ok) {
      throw new ResolverError(
        'unavailable',
        `Resolver '${id}' is not available (check config/env)`,
        id,
      );
    }
    return resolver.resolve({ input, context: ctx, timeoutMs: opts?.timeoutMs });
  }

  /** Unregister all resolvers. Useful for tests and hot-reload. */
  clear(): void {
    this.resolvers.clear();
  }

  /** Number of registered resolvers. */
  size(): number {
    return this.resolvers.size;
  }
}

function toSummary(r: Resolver<unknown, unknown>): ResolverSummary {
  return {
    id: r.id,
    cost: r.cost,
    backend: r.backend,
    description: r.description,
    hasInputSchema: !!r.inputSchema,
    hasOutputSchema: !!r.outputSchema,
  };
}

// ---------------------------------------------------------------------------
// Default process-wide registry
// ---------------------------------------------------------------------------

let _defaultRegistry: ResolverRegistry | null = null;

/** Get the default process-wide registry, creating it if needed. */
export function getDefaultRegistry(): ResolverRegistry {
  if (!_defaultRegistry) _defaultRegistry = new ResolverRegistry();
  return _defaultRegistry;
}

/** Reset the default registry. For tests only. */
export function _resetDefaultRegistry(): void {
  _defaultRegistry = null;
}
