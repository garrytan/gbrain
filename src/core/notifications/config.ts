/**
 * Outbound notification sinks: which events go where. One JSON array, read from the environment
 * (`GBRAIN_NOTIFY_SINKS`, wins) or the brain's config (`gbrain config set notify.sinks '<json>'`).
 * Off when neither is set: nothing is queued, the serve dispatcher does not start.
 *
 * A sink names its type (a registered sink type: `slack`, `webhook`, or one a deployment registers), the events it
 * receives, an optional filter, and its type's own keys. Credentials are never in the config: a sink names the
 * environment variables that hold them. Docs: docs/integrations/notification-sinks.md.
 */
import type { BrainEngine } from '../engine.ts';

export const NOTIFY_SINKS_KEY = 'notify.sinks';
export const NOTIFY_SINKS_ENV = 'GBRAIN_NOTIFY_SINKS';

export const NOTIFICATION_EVENTS = ['take_proposal.created', 'take_proposal.accepted', 'take_proposal.rejected'] as const;
export type NotificationEvent = typeof NOTIFICATION_EVENTS[number];

export interface SinkFilter {
  /** Lowest proposal weight delivered (0..1). */
  min_weight?: number;
  /** Proposal kinds delivered (fact, take, bet, hunch). */
  kinds?: string[];
  /** Page slug prefixes delivered (e.g. `airteam/`). */
  page_prefixes?: string[];
  holders?: string[];
  sources?: string[];
}

export interface SinkConfig {
  /** Unique, [a-z0-9-], at most 40 characters; recorded on each queued delivery. */
  name: string;
  type: string;
  /** Default true. A disabled sink queues nothing and delivers nothing. */
  enabled?: boolean;
  /** Events delivered; default every event. */
  events?: NotificationEvent[];
  filter?: SinkFilter;
  /** Type-specific keys (slack: channel, token_env, signing_secret_env, interactive, allowed_users, page_url). */
  [key: string]: unknown;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class SinkConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'SinkConfigError'; }
}

const strings = (value: unknown, key: string, sink: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) throw new SinkConfigError(`notify sink '${sink}': ${key} must be a list of non-empty strings`);
  return value.map(v => (v as string).trim());
};

/** Parse and validate the sinks array; throws SinkConfigError naming the first problem. */
export function parseSinks(raw: unknown): SinkConfig[] {
  const value = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { throw new SinkConfigError(`${NOTIFY_SINKS_KEY} is not valid JSON`); } })() : raw;
  if (value == null || value === '') return [];
  if (!Array.isArray(value)) throw new SinkConfigError(`${NOTIFY_SINKS_KEY} must be a JSON array of sinks`);
  const seen = new Set<string>();
  return value.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new SinkConfigError(`notify sink #${index + 1} must be an object`);
    const sink = entry as Record<string, unknown>;
    const name = typeof sink.name === 'string' ? sink.name : '';
    if (!NAME_RE.test(name)) throw new SinkConfigError(`notify sink #${index + 1}: name must match ${NAME_RE}`);
    if (seen.has(name)) throw new SinkConfigError(`notify sink '${name}' is defined twice`);
    seen.add(name);
    if (typeof sink.type !== 'string' || !sink.type) throw new SinkConfigError(`notify sink '${name}': type is required`);
    const events = strings(sink.events, 'events', name);
    for (const event of events ?? []) {
      if (!(NOTIFICATION_EVENTS as readonly string[]).includes(event)) throw new SinkConfigError(`notify sink '${name}': unknown event '${event}' (known: ${NOTIFICATION_EVENTS.join(', ')})`);
    }
    const filterRaw = sink.filter as Record<string, unknown> | undefined;
    if (filterRaw !== undefined && (typeof filterRaw !== 'object' || filterRaw === null || Array.isArray(filterRaw))) throw new SinkConfigError(`notify sink '${name}': filter must be an object`);
    const minWeight = filterRaw?.min_weight;
    if (minWeight !== undefined && (typeof minWeight !== 'number' || minWeight < 0 || minWeight > 1)) throw new SinkConfigError(`notify sink '${name}': filter.min_weight must be a number from 0 to 1`);
    const filter: SinkFilter | undefined = filterRaw ? {
      ...(minWeight !== undefined ? { min_weight: minWeight as number } : {}),
      ...(filterRaw.kinds !== undefined ? { kinds: strings(filterRaw.kinds, 'filter.kinds', name) } : {}),
      ...(filterRaw.page_prefixes !== undefined ? { page_prefixes: strings(filterRaw.page_prefixes, 'filter.page_prefixes', name) } : {}),
      ...(filterRaw.holders !== undefined ? { holders: strings(filterRaw.holders, 'filter.holders', name) } : {}),
      ...(filterRaw.sources !== undefined ? { sources: strings(filterRaw.sources, 'filter.sources', name) } : {}),
    } : undefined;
    if (sink.enabled !== undefined && typeof sink.enabled !== 'boolean') throw new SinkConfigError(`notify sink '${name}': enabled must be true or false`);
    return { ...sink, name, type: sink.type, ...(events ? { events: events as NotificationEvent[] } : {}), ...(filter ? { filter } : {}) } as SinkConfig;
  });
}

let cache: { at: number; sinks: SinkConfig[]; error: string | null } | null = null;
const CACHE_MS = 30_000;

/** Drop the cached config (tests, `notify` CLI after a config change). */
export function resetSinkConfigCache(): void { cache = null; }

/**
 * The configured sinks (enabled or not), cached for 30 s. A malformed config reads as no sinks plus an error:
 * notification failures never fail the write or cycle that emits them.
 */
export async function loadSinks(engine: BrainEngine, opts: { fresh?: boolean } = {}): Promise<{ sinks: SinkConfig[]; error: string | null }> {
  if (!opts.fresh && cache && Date.now() - cache.at < CACHE_MS) return { sinks: cache.sinks, error: cache.error };
  let sinks: SinkConfig[] = [];
  let error: string | null = null;
  try {
    const env = process.env[NOTIFY_SINKS_ENV]?.trim();
    const raw = env || await engine.getConfig(NOTIFY_SINKS_KEY);
    sinks = parseSinks(raw ?? null);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  cache = { at: Date.now(), sinks, error };
  return { sinks, error };
}

export function sinkEnabled(sink: SinkConfig): boolean { return sink.enabled !== false; }

export function sinkWantsEvent(sink: SinkConfig, event: NotificationEvent): boolean {
  return sinkEnabled(sink) && (!sink.events || sink.events.includes(event));
}

/** The proposal fields a filter reads. */
export interface FilterSubject { weight: number; kind: string; page_slug: string; holder: string; source_id: string }

export function filterMatches(filter: SinkFilter | undefined, subject: FilterSubject): boolean {
  if (!filter) return true;
  if (filter.min_weight !== undefined && !(Number(subject.weight) >= filter.min_weight)) return false;
  if (filter.kinds && !filter.kinds.includes(subject.kind)) return false;
  if (filter.page_prefixes && !filter.page_prefixes.some(prefix => subject.page_slug.startsWith(prefix))) return false;
  if (filter.holders && !filter.holders.includes(subject.holder)) return false;
  if (filter.sources && !filter.sources.includes(subject.source_id)) return false;
  return true;
}
