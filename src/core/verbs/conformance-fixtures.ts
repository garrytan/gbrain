/**
 * MEMORY_VERBS v1 — conformance fixtures (E2).
 *
 * The canonical, embedded fixture set the conformance runner executes against
 * ANY MCP endpoint (default: gbrain's own server). Deterministic by
 * construction: every check is SHAPE (required fields, enum validity, const),
 * CONTRACT BEHAVIOR (provenance rejected, idempotent forget, miss→found:false),
 * or ROUND-TRIP (remember → recall by entity, a plain indexed read — no
 * embeddings, no ranking judgment). Ranking quality is BrainBench's job.
 *
 * These double as BrainBench seeds: `test/fixtures/memory-verbs/cases.json` is
 * the generated data-file mirror (drift-guarded by the conformance test) so
 * the eval suite imports the same cases without importing gbrain source.
 *
 * Stateful round-trips share a per-run marker (substituted for `{{marker}}`)
 * and thread ids via `saveAs`/`{{id:<key>}}` substitution.
 */

export interface ConformanceCase {
  name: string;
  verb: 'recall' | 'remember' | 'entity' | 'synthesize' | 'forget';
  /** `{{marker}}` and `{{id:<key>}}` substitute at run time. */
  params: Record<string, unknown>;
  /** Validate the (parsed) response body against RESPONSE_SCHEMAS[verb]. */
  validateSchema?: boolean;
  /** Expect an isError response with this protocol code. */
  expectErrorCode?: string;
  /** On error responses: suggestion must be non-empty (F-D mandate). */
  expectSuggestion?: boolean;
  /** Field equality/predicate checks on the parsed response body. */
  expect?: Array<
    | { path: string; equals: unknown }
    | { path: string; oneOf: unknown[] }
    | { path: string; type: 'string' | 'number' | 'boolean' | 'array' | 'object' }
    | { path: string; gte: number }
    | { path: string; lte: number }
    | { path: string; nonEmptyString: true }
    | { path: string; absentOrNotContains: string }
  >;
  /** Save a response field for later cases ({{id:<key>}}). */
  saveAs?: { key: string; path: string };
  /** Only run when the runner was invoked with --synthesize (cost gate). */
  requiresSynthesizeFlag?: boolean;
  /**
   * Only run when the runner could seed the conformance entity PAGE (via
   * put_page when the target exposes it — full surface). entity() resolves
   * pages; on a verbs-only target with no seeding path these cases skip
   * honestly instead of failing on a structurally absent page.
   */
  requiresSeededEntity?: boolean;
}

export const CONFORMANCE_CASES: ConformanceCase[] = [
  // ── remember: contract behavior ─────────────────────────────────────────
  {
    name: 'remember rejects missing provenance (provenance_required + suggestion)',
    verb: 'remember',
    params: { fact: 'conformance {{marker}} fact without provenance' },
    expectErrorCode: 'invalid_params', // MCP-level required-param rejection
    expectSuggestion: false, // transport-level validation may not carry one
  },
  {
    name: 'remember rejects empty provenance (provenance_required + suggestion)',
    verb: 'remember',
    params: { fact: 'conformance {{marker}} fact empty provenance', provenance: '   ' },
    expectErrorCode: 'provenance_required',
    expectSuggestion: true,
  },
  {
    name: 'remember rejects ISO-8601 duration ttl with a fix (P30D trap)',
    verb: 'remember',
    params: { fact: 'conformance {{marker}} ttl trap', provenance: 'conformance run', ttl: 'P30D' },
    expectErrorCode: 'invalid_params',
    expectSuggestion: true,
  },
  {
    name: 'remember writes a fact (string id, enum status, echoed nulls)',
    verb: 'remember',
    params: {
      fact: 'conformance {{marker}}: the protocol round-trip fact',
      provenance: 'conformance run {{marker}}',
      entity: 'people/conformance-{{marker}}',
      kind: 'fact',
    },
    validateSchema: true,
    expect: [
      { path: 'id', type: 'string' },
      { path: 'status', oneOf: ['inserted', 'duplicate', 'superseded'] },
      { path: 'protocol_version', equals: 1 },
    ],
    saveAs: { key: 'fact1', path: 'id' },
  },
  {
    name: 'remember with ttl returns ISO valid_until',
    verb: 'remember',
    params: {
      fact: 'conformance {{marker}}: expiring fact',
      provenance: 'conformance run {{marker}}',
      entity: 'people/conformance-{{marker}}',
      ttl: '30d',
    },
    validateSchema: true,
    expect: [{ path: 'valid_until', type: 'string' }],
    saveAs: { key: 'fact2', path: 'id' },
  },
  {
    name: 'remember private fact (fence test setup)',
    verb: 'remember',
    params: {
      fact: 'conformance {{marker}} PRIVATE-SENTINEL commitment',
      provenance: 'conformance run {{marker}}',
      entity: 'people/conformance-{{marker}}',
      kind: 'commitment',
      visibility: 'private',
    },
    validateSchema: true,
  },

  // ── recall: round-trip + superset + budget ──────────────────────────────
  {
    name: 'recall by entity round-trips the remembered fact (superset envelope)',
    verb: 'recall',
    params: { entity: 'people/conformance-{{marker}}' },
    validateSchema: true,
    expect: [
      { path: 'protocol_version', equals: 1 },
      { path: 'total', gte: 1 },
      { path: 'facts.0.fact_id', type: 'string' },
      { path: 'facts.0.provenance', type: 'string' },
    ],
  },
  {
    name: 'recall with budget reports consistent budget meta',
    verb: 'recall',
    params: { entity: 'people/conformance-{{marker}}', budget_tokens: 10000 },
    validateSchema: true,
    expect: [
      { path: 'budget_tokens', equals: 10000 },
      { path: 'budget_used', gte: 0 },
      { path: 'budget_used', lte: 10000 },
      { path: 'dropped_count', gte: 0 },
    ],
  },
  {
    name: 'recall with budget smaller than the first item drops everything',
    verb: 'recall',
    params: { entity: 'people/conformance-{{marker}}', budget_tokens: 1 },
    validateSchema: true,
    expect: [
      { path: 'total', equals: 0 },
      { path: 'dropped_count', gte: 1 },
    ],
  },
  {
    name: 'recall with query returns the search arm (degradation allowed, never an error)',
    verb: 'recall',
    params: { query: 'conformance {{marker}} protocol round-trip', budget_tokens: 8000 },
    validateSchema: true,
    expect: [{ path: 'results', type: 'array' }],
  },

  // ── entity: hit, miss, privacy fence ────────────────────────────────────
  {
    name: 'entity resolves the round-trip entity to a card',
    verb: 'entity',
    params: { name: 'people/conformance-{{marker}}' },
    validateSchema: true,
    requiresSeededEntity: true,
    expect: [
      { path: 'found', equals: true },
      { path: 'protocol_version', equals: 1 },
      { path: 'card.entity.slug', type: 'string' },
      { path: 'card.backlink_count', gte: 0 },
    ],
  },
  {
    name: 'entity miss returns found:false + suggestions (never an error)',
    verb: 'entity',
    params: { name: 'zzz-no-such-entity-{{marker}}' },
    validateSchema: true,
    expect: [
      { path: 'found', equals: false },
      { path: 'suggestions', type: 'array' },
    ],
  },
  {
    name: 'entity card never leaks private facts to remote callers (fence test)',
    verb: 'entity',
    params: { name: 'people/conformance-{{marker}}' },
    requiresSeededEntity: true,
    expect: [{ path: 'card.open_threads', absentOrNotContains: 'PRIVATE-SENTINEL' }],
  },

  // ── forget: idempotency + not_found ─────────────────────────────────────
  {
    name: 'forget expires the remembered fact',
    verb: 'forget',
    params: { id: '{{id:fact2}}', reason: 'conformance cleanup' },
    validateSchema: true,
    expect: [{ path: 'expired', equals: true }],
  },
  {
    name: 'forget again is idempotent (expired:false, success)',
    verb: 'forget',
    params: { id: '{{id:fact2}}' },
    validateSchema: true,
    expect: [{ path: 'expired', equals: false }],
  },
  {
    name: 'forget unknown id returns not_found with a suggestion',
    verb: 'forget',
    params: { id: '999999999' },
    expectErrorCode: 'not_found',
    expectSuggestion: true,
  },

  // ── synthesize: cost-gated live call ────────────────────────────────────
  {
    name: 'synthesize answers (or reports unavailable) — cost-gated, pass --synthesize',
    verb: 'synthesize',
    params: { question: 'What do we know about conformance {{marker}}?' },
    requiresSynthesizeFlag: true,
    // Either a schema-valid answer (key configured) or a clean unavailable
    // error (no key). The runner accepts both; anything else fails.
  },
];
