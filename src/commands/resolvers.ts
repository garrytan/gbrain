/**
 * gbrain resolvers — introspect the Resolver SDK registry.
 *
 * Subcommands:
 *   gbrain resolvers list              Pretty table of all registered resolvers.
 *   gbrain resolvers list --json       Machine-readable output.
 *   gbrain resolvers describe <id>     Detail view: schema + availability.
 *
 * No engine connection required — the registry is in-memory. Loads the
 * embedded builtins at invocation time; future plugin discovery (from
 * ~/.gbrain/resolvers/) plugs in here.
 */

import {
  getDefaultRegistry,
  type ResolverContext,
  type ResolverSummary,
} from '../core/resolvers/index.ts';
import { urlReachableResolver } from '../core/resolvers/builtin/url-reachable.ts';
import { xHandleToTweetResolver } from '../core/resolvers/builtin/x-api/handle-to-tweet.ts';

/**
 * Register all embedded builtin resolvers into the given registry.
 * Idempotent: skips registration if the id is already present so it's safe
 * to call from multiple entry points.
 */
export function registerBuiltinResolvers(registry = getDefaultRegistry()): void {
  // Cast each element to the widest shape the registry accepts. The tuple
  // element types diverge (different Input/Output generics) so the union
  // type would not satisfy registry.register's single-signature parameter.
  const builtins = [urlReachableResolver, xHandleToTweetResolver];
  for (const r of builtins) {
    if (!registry.has(r.id)) registry.register(r as Parameters<typeof registry.register>[0]);
  }
}

export async function runResolvers(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }

  if (sub === 'list') {
    await cmdList(args.slice(1));
    return;
  }

  if (sub === 'describe') {
    await cmdDescribe(args.slice(1));
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  printHelp();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function cmdList(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const costFilter = extractFlag(args, '--cost');
  const backendFilter = extractFlag(args, '--backend');

  registerBuiltinResolvers();
  const registry = getDefaultRegistry();

  const filter: { cost?: 'free' | 'rate-limited' | 'paid'; backend?: string } = {};
  if (costFilter) {
    if (costFilter !== 'free' && costFilter !== 'rate-limited' && costFilter !== 'paid') {
      console.error(`Invalid --cost value: ${costFilter}. Must be one of: free, rate-limited, paid.`);
      process.exit(1);
    }
    filter.cost = costFilter;
  }
  if (backendFilter) filter.backend = backendFilter;

  const summaries = registry.list(filter);

  if (json) {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }

  if (summaries.length === 0) {
    console.log('No resolvers registered.');
    return;
  }

  printTable(summaries);
}

function printTable(summaries: ResolverSummary[]): void {
  const rows = summaries.map(s => ({
    id: s.id,
    cost: s.cost,
    backend: s.backend,
    description: s.description ?? '',
  }));

  const widths = {
    id: Math.max(2, ...rows.map(r => r.id.length)),
    cost: Math.max(4, ...rows.map(r => r.cost.length)),
    backend: Math.max(7, ...rows.map(r => r.backend.length)),
  };

  const hdr = `${pad('ID', widths.id)}  ${pad('COST', widths.cost)}  ${pad('BACKEND', widths.backend)}  DESCRIPTION`;
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const r of rows) {
    console.log(`${pad(r.id, widths.id)}  ${pad(r.cost, widths.cost)}  ${pad(r.backend, widths.backend)}  ${r.description}`);
  }
  console.log(`\n${summaries.length} resolver${summaries.length === 1 ? '' : 's'} registered.`);
}

function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - s.length));
}

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------

async function cmdDescribe(args: string[]): Promise<void> {
  const id = args.find(a => !a.startsWith('--'));
  if (!id) {
    console.error('Usage: gbrain resolvers describe <id>');
    process.exit(1);
  }

  registerBuiltinResolvers();
  const registry = getDefaultRegistry();

  if (!registry.has(id)) {
    console.error(`Resolver not found: ${id}`);
    console.error(`Available: ${registry.list().map(r => r.id).join(', ')}`);
    process.exit(1);
  }

  const resolver = registry.get(id);
  const ctx: ResolverContext = {
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    requestId: 'describe',
    remote: false,
  };
  const available = await resolver.available(ctx);

  console.log(`ID:          ${resolver.id}`);
  console.log(`Cost:        ${resolver.cost}`);
  console.log(`Backend:     ${resolver.backend}`);
  if (resolver.description) console.log(`Description: ${resolver.description}`);
  console.log(`Available:   ${available ? 'yes' : 'no (check env/config)'}`);
  if (resolver.inputSchema) {
    console.log('\nInput schema:');
    console.log(JSON.stringify(resolver.inputSchema, null, 2));
  }
  if (resolver.outputSchema) {
    console.log('\nOutput schema:');
    console.log(JSON.stringify(resolver.outputSchema, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function extractFlag(args: string[], flag: string): string | undefined {
  const idx = args.findIndex(a => a === flag || a.startsWith(`${flag}=`));
  if (idx === -1) return undefined;
  const arg = args[idx];
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  return args[idx + 1];
}

function printHelp(): void {
  console.log(`Usage: gbrain resolvers <subcommand> [options]

Subcommands:
  list                    List all registered resolvers (pretty table)
  list --json             List as JSON
  list --cost <c>         Filter by cost: free, rate-limited, paid
  list --backend <b>      Filter by backend label
  describe <id>           Show schema + availability for a single resolver

Examples:
  gbrain resolvers list
  gbrain resolvers list --cost paid
  gbrain resolvers describe x_handle_to_tweet
`);
}
