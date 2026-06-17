/**
 * Resolver SDK public surface.
 *
 * Import from 'gbrain/resolvers' (or '../core/resolvers' internally) rather
 * than reaching into ./interface or ./registry directly.
 */

export type {
  Resolver,
  ResolverCost,
  ResolverContext,
  ResolverRequest,
  ResolverResult,
  ResolverLogger,
  ResolverErrorCode,
} from './interface.ts';

export { ResolverError } from './interface.ts';

export {
  ResolverRegistry,
  getDefaultRegistry,
  _resetDefaultRegistry,
} from './registry.ts';

export type { ResolverListFilter, ResolverSummary } from './registry.ts';
