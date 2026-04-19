/**
 * Tier 5: Fuzzy / Vibe queries.
 *
 * Vague recall and "I know I mentioned this somewhere" — the kind of query
 * real people ask their brain when they can't quite remember the exact
 * entity name. Graph-heavy systems shouldn't have an inherent edge here
 * because the query doesn't mention the target entity precisely.
 *
 * Per the 4-review arc: these address Codex's circularity critique
 * ("gbrain's adversarial list is its product roadmap"). If gbrain loses
 * ground on vague queries while winning on relational ones, that's an
 * honest tradeoff story. If gbrain wins on BOTH, that's a stronger
 * benchmark claim.
 *
 * Target: ~30 queries (statistical floor per eng pass 3).
 *
 * Gold derivation: each query specifies an expected answer slug set based
 * on the canonical world (eval/data/world-v1/_ledger.json). We fix a small
 * set of landmarks here rather than deriving from _facts — fuzzy queries
 * don't map 1:1 to _facts fields.
 */

import type { Query } from '../types.ts';

/**
 * Hand-authored Tier 5 vibe queries. Each targets real entities from
 * eval/data/world-v1/ that actually exist in the corpus. Slugs verified
 * against world-v1 shards at authoring time.
 */
export const TIER5_FUZZY_QUERIES: Query[] = [
  // ── "I know I mentioned this somewhere" style ─────────────────────
  {
    id: 'q5-0001',
    tier: 'fuzzy',
    text: 'Someone I know was a senior engineer at a biotech company doing drug discovery — who?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    as_of_date: 'per-source',
    tags: ['vague-recall', 'role-based'],
    known_failure_modes: ['might return all biotech company pages; we want the person'],
  },
  {
    id: 'q5-0002',
    tier: 'fuzzy',
    text: 'The crypto-infra founder who did a stint at Goldman before building his own thing',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    tags: ['vague-recall', 'biographical'],
  },
  {
    id: 'q5-0003',
    tier: 'fuzzy',
    text: 'The security advisor woman based in Boston, multi-year engagement with a cybersecurity startup',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['vague-recall', 'role-based', 'location'],
  },

  // ── Summarization-over-messy-notes style ──────────────────────────
  {
    id: 'q5-0004',
    tier: 'fuzzy',
    text: 'Summarize what we know about founders who raised Series A in 2024.',
    expected_output_type: 'answer-string',
    gold: { relevant: [] },
    acceptable_variants: ['Series A 2024 founders summary'],
    tags: ['summarization', 'multi-entity'],
    known_failure_modes: ['accept any top-K that includes actual Series-A-2024 founders'],
  },
  {
    id: 'q5-0005',
    tier: 'fuzzy',
    text: 'Who are the fintech advisors in our network?',
    expected_output_type: 'abstention',
    gold: { expected_abstention: true },
    tags: ['summarization', 'role-intersection', 'partial-in-corpus'],
    known_failure_modes: ['"fintech" advisors are scarce in twin-amara corpus; a good system abstains or flags partial match'],
  },
  {
    id: 'q5-0006',
    tier: 'fuzzy',
    text: 'Tell me about the people who push back hard on microservices',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['trait-based', 'opinion'],
    known_failure_modes: ['requires catching "controversial internal memo on microservices" in prose'],
  },

  // ── Partial-information recall ────────────────────────────────────
  {
    id: 'q5-0007',
    tier: 'fuzzy',
    text: 'Who has a "40 under 40" mention?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    tags: ['biographical-fragment'],
  },
  {
    id: 'q5-0008',
    tier: 'fuzzy',
    text: 'The company whose CEO insists on founder-friendly terms and minimal board seats',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['companies/forge-19'] },
    tags: ['trait-based', 'culture'],
  },
  {
    id: 'q5-0009',
    tier: 'fuzzy',
    text: 'Someone we know who cut sequencing pipeline runtime by about 40%',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['achievement-based'],
  },
  {
    id: 'q5-0010',
    tier: 'fuzzy',
    text: 'The person who wrote an internal memo about deleting half the microservices',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['behavioral-recall'],
  },

  // ── "what was that thing about..." style ──────────────────────────
  {
    id: 'q5-0011',
    tier: 'fuzzy',
    text: 'What was the thing about MEV-resistant transaction ordering?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    as_of_date: 'per-source',
    tags: ['topic-recall'],
  },
  {
    id: 'q5-0012',
    tier: 'fuzzy',
    text: 'The partner who focuses on early-stage fintech',
    expected_output_type: 'abstention',
    gold: { expected_abstention: true },
    tags: ['role-based', 'domain', 'partial-in-corpus'],
    known_failure_modes: ['multiple partial matches; good systems either abstain or flag "multiple candidates"'],
  },
  {
    id: 'q5-0013',
    tier: 'fuzzy',
    text: 'Which Layer 1 project did that crypto guy leave over tokenomics disagreements?',
    expected_output_type: 'abstention',
    gold: { expected_abstention: true },
    known_failure_modes: ['prose says a Layer 1 project but never names it; good systems abstain'],
    tags: ['abstention', 'under-specified'],
  },
  {
    id: 'q5-0014',
    tier: 'fuzzy',
    text: 'Who built that cross-chain messaging protocol?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['companies/forge-19'] },
    tags: ['product-feature-recall'],
  },
  {
    id: 'q5-0015',
    tier: 'fuzzy',
    text: 'The engineer who is notoriously demanding on code review',
    expected_output_type: 'abstention',
    gold: { expected_abstention: true },
    as_of_date: 'corpus-end',
    known_failure_modes: ['no single canonical answer in corpus; good systems flag ambiguity'],
    tags: ['trait-based', 'partial-in-corpus'],
  },

  // ── Emotional / cultural recall ──────────────────────────────────
  {
    id: 'q5-0016',
    tier: 'fuzzy',
    text: 'The company whose culture is described as "either loved or hated"',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['companies/forge-19'] },
    as_of_date: 'per-source',
    tags: ['culture-recall'],
  },
  {
    id: 'q5-0017',
    tier: 'fuzzy',
    text: 'The advisor who pushed hard for zero-trust architecture overhaul',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['behavior-recall', 'advocacy'],
  },
  {
    id: 'q5-0018',
    tier: 'fuzzy',
    text: 'Someone who speaks selectively at conferences and prefers small venues',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['preference-recall'],
  },
  {
    id: 'q5-0019',
    tier: 'fuzzy',
    text: 'Who is rumored to be writing a book on security culture?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    as_of_date: 'corpus-end',
    tags: ['gossip', 'side-project'],
  },

  // ── "something about X" generic-topic style ──────────────────────
  {
    id: 'q5-0020',
    tier: 'fuzzy',
    text: 'Any portfolio companies focused on drug discovery?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['companies/delta-3'] },
    tags: ['topical', 'industry'],
  },
  {
    id: 'q5-0021',
    tier: 'fuzzy',
    text: 'Who among our founders worked at Goldman Sachs?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    tags: ['background-intersection'],
  },
  {
    id: 'q5-0022',
    tier: 'fuzzy',
    text: 'The person with an MIT CS background who dropped out of a PhD',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    tags: ['biography-fragment'],
  },
  {
    id: 'q5-0023',
    tier: 'fuzzy',
    text: 'Who among our people is a long-distance runner?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    as_of_date: 'corpus-end',
    tags: ['personal-trait'],
  },

  // ── Negative / abstention fuzzy (known failure bait) ─────────────
  {
    id: 'q5-0024',
    tier: 'fuzzy',
    text: 'Which YC W18 founder built an analytics dashboard?',
    expected_output_type: 'abstention',
    gold: { expected_abstention: true },
    tags: ['abstention', 'not-in-corpus'],
    known_failure_modes: ['W18 batch doesn\'t exist in this corpus; good systems abstain'],
  },
  {
    id: 'q5-0025',
    tier: 'fuzzy',
    text: 'Who founded the developer-tools company that got acquihired by Roche?',
    expected_output_type: 'abstention',
    gold: { expected_abstention: true },
    tags: ['abstention', 'mentioned-but-not-named'],
    known_failure_modes: ['prose mentions a bioinformatics startup acquired by Roche but never names it; good systems abstain'],
  },

  // ── Cross-referencing without exact entity names ─────────────────
  {
    id: 'q5-0026',
    tier: 'fuzzy',
    text: 'What companies have enterprise security architecture help from an outside advisor?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['companies/prism-43'] },
    tags: ['relational-fuzzy'],
  },
  {
    id: 'q5-0027',
    tier: 'fuzzy',
    text: 'Who is known as a "systems builder" in the security space?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    as_of_date: 'corpus-end',
    tags: ['epithet-recall'],
  },
  {
    id: 'q5-0028',
    tier: 'fuzzy',
    text: 'The Boston-based person who completed a SOC 2 audit for someone',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['achievement-plus-location'],
  },
  {
    id: 'q5-0029',
    tier: 'fuzzy',
    text: 'Which advisor has SecureCon Northeast speaking experience?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['conference-history'],
  },
  {
    id: 'q5-0030',
    tier: 'fuzzy',
    text: 'Someone who published multiple technical papers on cryptographic primitives',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    tags: ['academic-output'],
  },
];

export function getTier5FuzzyQueries(): Query[] {
  // Defensive copy so callers can't mutate the canonical set.
  return TIER5_FUZZY_QUERIES.map(q => ({ ...q, gold: { ...q.gold }, tags: q.tags ? [...q.tags] : undefined }));
}
