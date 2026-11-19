/**
 * Ontology dimensions over facts (BrainEngine mergeOntologyFact, getOntology, discoverOntologyDimensions,
 * findOntologyConflicts).
 *
 * Each member applies the defaults of src/core/pglite-engine.ts, then makes one store call. mergeOntologyFact
 * normalises the dimension, computes the value hash, the default status and the fact text here, with the helpers
 * PGLite uses (src/core/chronicle/ontology.ts). Times go to the store as ISO text. What the store cannot answer exactly
 * refuses with `engine_capability_missing`: `excludePrivate` for a caller other than the one the store's policy models
 * (private-provenance.ts) and a time in a text form other than an ISO date or date-time, which Postgres would read by
 * its own rules.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served.
 */
import type { BrainEngine } from '../../engine.ts';
import type { OntologyReadOpts } from '../../types.ts';
import { isNovelDimension, normalizeDimension, valueHash } from '../../chronicle/ontology.ts';
import { ensureWellFormed } from '../../text-safe.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePrivacyPolicy } from './private-provenance.ts';
import { privateFactFilterForReader } from '../../search/private-visibility.ts';
import { withDates } from '../store-codec.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type OntologyValue = Awaited<ReturnType<BrainEngine['getOntology']>>[number];

/** Read options PGLite accepts and does not read (the rest of PageReadScope / PageReadPolicy). */
const IGNORED = ['requireSafeChunks', 'minTrust', 'suppressFlagged', 'takesHoldersAllowList'] as const;
const SCOPE = ['sourceId', 'sourceIds'] as const;

/** An ISO date, or a date-time with an optional fraction (up to microseconds) and zone. */
const TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/**
 * `text::timestamptz` as the UTC session of PGLite reads it, as microsecond ISO text. A text form outside TIME, or a
 * field out of range, refuses: Postgres reads or rejects those by rules the store does not have.
 */
function pgTime(member: string, what: string, text: unknown): string {
  const m = typeof text === 'string' ? TIME.exec(text) : null;
  if (!m) refuseMember(member, `${what} in another text form`);
  const [, y, mo, d, h = '00', mi = '00', s = '00', frac = '', zone] = m;
  const fields = [+y, +mo - 1, +d, +h, +mi, +s] as const;
  const local = new Date(Date.UTC(...fields));
  local.setUTCFullYear(fields[0]);
  if (fields[0] < 1 || local.getUTCMonth() !== fields[1] || local.getUTCDate() !== fields[2]
    || fields[3] > 23 || fields[4] > 59 || fields[5] > 59) {
    refuseMember(member, `${what} out of range`);
  }
  let offset = 0;
  if (zone && zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    const hours = +digits.slice(0, 2);
    const minutes = digits.length > 2 ? +digits.slice(2) : 0;
    if (hours > 15 || minutes > 59) refuseMember(member, `${what} out of range`);
    offset = (zone[0] === '-' ? -1 : 1) * (hours * 60 + minutes);
  }
  const utc = new Date(local.getTime() - offset * 60_000);
  if (Number.isNaN(utc.getTime()) || utc.getUTCFullYear() < 1 || utc.getUTCFullYear() > 9999) {
    refuseMember(member, `${what} out of range`);
  }
  return `${utc.toISOString().slice(0, 19)}.${frac.padEnd(6, '0')}Z`;
}

const optTime = (member: string, what: string, text: string | null | undefined): string | undefined =>
  (text == null ? undefined : pgTime(member, what, text));

/** A number bound against `confidence`: a non-finite one compares as PGLite's does (NaN and +Infinity match no row). */
const floor = (n: number): number => (Number.isNaN(n) || n === Infinity ? 2 : n === -Infinity ? -1 : n);

function scopeOf(o: { sourceId?: string; sourceIds?: string[] }): string[] | undefined {
  if (Array.isArray(o.sourceIds) && o.sourceIds.length > 0) return [...o.sourceIds];
  return o.sourceId == null ? undefined : [o.sourceId];
}

/** The page gates, private-provenance policy, visibility list and confidence floor getOntology and findOntologyConflicts share. */
function readFilters(member: string, o: OntologyReadOpts): Record<string, unknown> {
  return {
    sourceIds: scopeOf(o),
    minConfidence: floor(o.minConfidence ?? 0),
    visibility: o.visibility == null ? undefined : [...o.visibility],
    excludeDiary: o.excludeDiary === true,
    // pglite-engine.ts getOntology / findOntologyConflicts: `privateFactFilterForReader('facts')`. A caller with a
    // reader identity and a private-readable grant is served (`callerReaders`).
    excludePrivate: storePrivacyPolicy(member, o.excludePrivate, () => privateFactFilterForReader('facts'), { callerReaders: true }),
  };
}

export const mergeOntologyFact: Member<'mergeOntologyFact'> = (brain, obs) => {
  const member = 'mergeOntologyFact';
  const dimension = normalizeDimension(obs.dimension);
  const vh = valueHash(obs.value);
  const confidence = obs.confidence ?? 0.7;
  const status = obs.status ?? (isNovelDimension(dimension) ? 'quarantined' : 'active');
  const row = {
    sourceId: ensureWellFormed(obs.sourceId ?? 'default'),
    entitySlug: ensureWellFormed(obs.entitySlug),
    dimension: ensureWellFormed(dimension),
    value: ensureWellFormed(obs.value),
    valueHash: vh,
    fact: ensureWellFormed(`${dimension}: ${obs.value}`),
    confidence: Number.isFinite(confidence) ? confidence : 2,
    status: ensureWellFormed(status),
    visibility: obs.visibility ?? 'private',
    source: ensureWellFormed(obs.source),
    validFrom: optTime(member, 'validFrom', obs.validFrom),
    validTo: optTime(member, 'validTo', obs.validTo),
  };
  return storeCall({ member }, () => brain.mergeOntologyFact(row));
};

export const getOntology: Member<'getOntology'> = async (brain, entitySlug, opts) => {
  const member = 'getOntology';
  const o = takeOptions(member, opts, ['asof', 'minConfidence', 'includeQuarantined', 'visibility', 'excludeDiary',
    'excludePrivate', ...SCOPE], IGNORED) as OntologyReadOpts;
  const rows: Record<string, unknown>[] = await storeCall({ member }, () => brain.getOntology({
    ...readFilters(member, o),
    entitySlug: ensureWellFormed(entitySlug),
    asof: optTime(member, 'asof', o.asof),
    includeQuarantined: o.includeQuarantined === true,
  }));
  return rows.map((row) => withDates(row, ['valid_from', 'valid_to']) as unknown as OntologyValue);
};

export const discoverOntologyDimensions: Member<'discoverOntologyDimensions'> = (brain, opts) => {
  const member = 'discoverOntologyDimensions';
  const o = takeOptions(member, opts, SCOPE) as { sourceId?: string; sourceIds?: string[] };
  return storeCall({ member }, () => brain.discoverOntologyDimensions({ sourceIds: scopeOf(o) }));
};

export const findOntologyConflicts: Member<'findOntologyConflicts'> = (brain, opts) => {
  const member = 'findOntologyConflicts';
  const o = takeOptions(member, opts, ['minConfidence', 'visibility', 'excludeDiary', 'excludePrivate', ...SCOPE],
    IGNORED) as OntologyReadOpts;
  return storeCall({ member }, () => brain.findOntologyConflicts(readFilters(member, o)));
};
