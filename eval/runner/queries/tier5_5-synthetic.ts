/**
 * Tier 5.5: Externally-Authored queries (SYNTHETIC placeholder).
 *
 * Per plan file: real Tier 5.5 requires 2-3 outside researchers writing
 * ~50 queries each against the committed corpus. That's a human-in-the-loop
 * deliverable (see eval/CONTRIBUTING.md for how to submit).
 *
 * This file ships a SYNTHETIC placeholder set: AI-authored queries that
 * deliberately vary phrasing patterns to simulate what an outsider would
 * write. They are CLEARLY labeled via `author: "synthetic-outsider-v1"`
 * so real researcher submissions can supersede them without ambiguity.
 *
 * Why ship synthetic ones at all:
 *   - Tier 5.5 has to exist in the scorecard for the multi-axis report
 *     to have a full column. A missing tier reads as "not measured."
 *   - The synthetic set establishes phrasing variety (full sentences,
 *     short fragments, follow-up style, comparison style, "what's the
 *     difference between X and Y" style) that the 4 template families
 *     in the medium tier don't cover.
 *   - When real researchers submit, scorecards can compare "AI-authored"
 *     vs "human-authored" columns to flag where LLM judgment differs
 *     from human judgment on the same corpus.
 *
 * Author field: "synthetic-outsider-v1" for every query here.
 *
 * Gold verification: slugs referenced below exist in eval/data/world-v1/.
 * Small slug set for authenticity; entity pages cited: adam-lee-19,
 * adam-lopez-113, alice-davis-172, forge-19, delta-3, prism-43,
 * orbit-labs-92 (+ others from the corpus).
 */

import type { Query } from '../types.ts';

const AUTHOR = 'synthetic-outsider-v1';

export const TIER5_5_SYNTHETIC_QUERIES: Query[] = [
  // ─── Short-fragment style (how real researchers write notes) ─────
  { id: 'q55-0001', tier: 'externally-authored', author: AUTHOR,
    text: 'crypto founder Goldman Sachs background',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    tags: ['fragment-style'] },
  { id: 'q55-0002', tier: 'externally-authored', author: AUTHOR,
    text: 'Prism cybersecurity advisor engagement history',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172', 'companies/prism-43'] },
    tags: ['fragment-style', 'relational'] },
  { id: 'q55-0003', tier: 'externally-authored', author: AUTHOR,
    text: 'Delta biotech engineers',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['fragment-style'] },
  { id: 'q55-0004', tier: 'externally-authored', author: AUTHOR,
    text: 'Forge crypto infrastructure founder details',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19', 'companies/forge-19'] },
    tags: ['fragment-style', 'founder-company'] },

  // ─── Full-sentence style with natural hedging ─────────────────────
  { id: 'q55-0005', tier: 'externally-authored', author: AUTHOR,
    text: 'Can you pull up what we have on the founder who left a Layer 1 project over tokenomics?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    tags: ['polite-natural'] },
  { id: 'q55-0006', tier: 'externally-authored', author: AUTHOR,
    text: 'I need the background on the Delta senior engineer who cut pipeline runtime',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['polite-natural', 'specific-achievement'] },
  { id: 'q55-0007', tier: 'externally-authored', author: AUTHOR,
    text: 'Please find the advisor with SOC 2 audit prep experience at Orbit Labs',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['polite-natural', 'relational'] },

  // ─── Comparison / differentiation style ───────────────────────────
  { id: 'q55-0008', tier: 'externally-authored', author: AUTHOR,
    text: 'What is the difference between Adam Lee and Adam Lopez in our network?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19', 'people/adam-lopez-113'] },
    as_of_date: 'corpus-end',
    tags: ['disambiguation', 'comparison'] },
  { id: 'q55-0009', tier: 'externally-authored', author: AUTHOR,
    text: 'Compare Forge and Delta as companies in our portfolio',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['companies/forge-19', 'companies/delta-3'] },
    tags: ['comparison'] },
  { id: 'q55-0010', tier: 'externally-authored', author: AUTHOR,
    text: 'Which of our advisors is based on the East Coast?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    as_of_date: 'corpus-end',
    tags: ['location-filter'] },

  // ─── Who-does-what style (role-first) ──────────────────────────────
  { id: 'q55-0011', tier: 'externally-authored', author: AUTHOR,
    text: 'Who focuses on synthetic biology at Delta?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['role-first'] },
  { id: 'q55-0012', tier: 'externally-authored', author: AUTHOR,
    text: 'Who wrote the whitepaper on MEV-resistant transaction ordering?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    tags: ['achievement-first'] },
  { id: 'q55-0013', tier: 'externally-authored', author: AUTHOR,
    text: 'Who would you ask about enterprise security architecture?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['skill-lookup'] },
  { id: 'q55-0014', tier: 'externally-authored', author: AUTHOR,
    text: 'Who is the expert on bioinformatics pipelines in our network?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    as_of_date: 'corpus-end',
    tags: ['expertise-lookup'] },

  // ─── Follow-up style (assumes prior context) ──────────────────────
  { id: 'q55-0015', tier: 'externally-authored', author: AUTHOR,
    text: 'And who else advises Orbit Labs?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['follow-up', 'assumed-context'] },
  { id: 'q55-0016', tier: 'externally-authored', author: AUTHOR,
    text: 'Also at Delta?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['follow-up', 'minimal'] },

  // ─── Characteristic / trait recall ─────────────────────────────────
  { id: 'q55-0017', tier: 'externally-authored', author: AUTHOR,
    text: 'Our demanding engineering leader with the long-term vision approach',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    tags: ['trait-description'] },
  { id: 'q55-0018', tier: 'externally-authored', author: AUTHOR,
    text: 'The fast-shipping opinionated engineer (likes Postgres, hates meetings)',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['multi-trait'] },
  { id: 'q55-0019', tier: 'externally-authored', author: AUTHOR,
    text: 'A systems-builder style advisor who scales security architecture',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['epithet-plus-role'] },

  // ─── Misspellings / typos (real researchers make these) ───────────
  { id: 'q55-0020', tier: 'externally-authored', author: AUTHOR,
    text: 'adam lee the crypto guy',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    tags: ['lowercase', 'minimal-name'] },
  { id: 'q55-0021', tier: 'externally-authored', author: AUTHOR,
    text: 'alice davis cybersecuirty advisor',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['typo', 'lowercase'] },
  { id: 'q55-0022', tier: 'externally-authored', author: AUTHOR,
    text: 'adam lopez bioinformatcis',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['typo'] },

  // ─── "Find me someone like..." semantic-similarity style ─────────
  { id: 'q55-0023', tier: 'externally-authored', author: AUTHOR,
    text: 'Find me someone like Alice Davis for our new security engagement',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['recommendation', 'similarity'] },
  { id: 'q55-0024', tier: 'externally-authored', author: AUTHOR,
    text: 'Who has a profile similar to Adam Lopez — fast shipper, infrastructure background?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['similarity', 'profile-match'] },

  // ─── Negative / "is there anyone..." phrasing ────────────────────
  { id: 'q55-0025', tier: 'externally-authored', author: AUTHOR,
    text: 'Is there anyone in our network who has given a Mainnet conference keynote?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    as_of_date: 'corpus-end',
    tags: ['existence-check'] },
  { id: 'q55-0026', tier: 'externally-authored', author: AUTHOR,
    text: 'Does anyone know someone who has published on cryptographic primitives?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    tags: ['existence-check', 'topic-lookup'] },

  // ─── "What does X do?" direct-entity-name style ──────────────────
  { id: 'q55-0027', tier: 'externally-authored', author: AUTHOR,
    text: 'What does Forge do?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['companies/forge-19'] },
    tags: ['direct-lookup'] },
  { id: 'q55-0028', tier: 'externally-authored', author: AUTHOR,
    text: 'What is Prism working on these days?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['companies/prism-43'] },
    as_of_date: 'corpus-end',
    tags: ['direct-lookup', 'temporal-latest'] },
  { id: 'q55-0029', tier: 'externally-authored', author: AUTHOR,
    text: "Tell me about Delta's drug discovery platform",
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['companies/delta-3'] },
    tags: ['direct-lookup', 'domain-specific'] },

  // ─── Cross-cutting relationship queries ─────────────────────────
  { id: 'q55-0030', tier: 'externally-authored', author: AUTHOR,
    text: 'People we know who are associated with both biotech and software infrastructure',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['cross-domain'] },
  { id: 'q55-0031', tier: 'externally-authored', author: AUTHOR,
    text: 'Companies where our advisors have multi-year ongoing relationships',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['companies/prism-43'] },
    tags: ['relationship-depth'] },

  // ─── Role-plus-industry intersection ──────────────────────────────
  { id: 'q55-0032', tier: 'externally-authored', author: AUTHOR,
    text: 'Any security-focused advisors for enterprise clients?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['role-industry-intersect'] },
  { id: 'q55-0033', tier: 'externally-authored', author: AUTHOR,
    text: 'Senior infrastructure engineers in synthetic biology',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['role-industry-intersect'] },

  // ─── "Pull up..." imperative style ───────────────────────────────
  { id: 'q55-0034', tier: 'externally-authored', author: AUTHOR,
    text: 'Pull up Alice Davis',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['imperative', 'direct-name'] },
  { id: 'q55-0035', tier: 'externally-authored', author: AUTHOR,
    text: 'Show me the Forge page',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['companies/forge-19'] },
    tags: ['imperative', 'direct-page'] },

  // ─── Background-check style ──────────────────────────────────────
  { id: 'q55-0036', tier: 'externally-authored', author: AUTHOR,
    text: 'Prior experience of Delta senior engineers before joining',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['background-check'] },
  { id: 'q55-0037', tier: 'externally-authored', author: AUTHOR,
    text: 'Educational background of Forge founder',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    tags: ['biographical'] },

  // ─── "When did X..." abstention-adjacent ─────────────────────────
  { id: 'q55-0038', tier: 'externally-authored', author: AUTHOR,
    text: 'When did Adam Lopez earn his masters degree?',
    expected_output_type: 'abstention',
    gold: { expected_abstention: true },
    as_of_date: 'corpus-end',
    tags: ['abstention', 'not-in-corpus'],
    known_failure_modes: ['no mention of Lopez getting a masters; abstain'] },
  { id: 'q55-0039', tier: 'externally-authored', author: AUTHOR,
    text: 'Was Alice Davis ever at Palo Alto Networks?',
    expected_output_type: 'abstention',
    gold: { expected_abstention: true },
    as_of_date: 'corpus-end',
    tags: ['abstention', 'speculation-bait'] },

  // ─── Aggregation queries ─────────────────────────────────────────
  { id: 'q55-0040', tier: 'externally-authored', author: AUTHOR,
    text: 'List all advisors in our corpus',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    tags: ['aggregation', 'partial-gold'],
    known_failure_modes: ['partial gold; accept any adviser-role pages in top-K'] },
  { id: 'q55-0041', tier: 'externally-authored', author: AUTHOR,
    text: 'All senior engineers',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    tags: ['aggregation', 'role-filter'] },

  // ─── Topic-with-no-entity-name (true semantic) ───────────────────
  { id: 'q55-0042', tier: 'externally-authored', author: AUTHOR,
    text: 'Zero-trust architecture work',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172', 'companies/prism-43'] },
    tags: ['topic-only'] },
  { id: 'q55-0043', tier: 'externally-authored', author: AUTHOR,
    text: 'Mainnet cross-chain messaging',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['companies/forge-19'] },
    tags: ['topic-only'] },
  { id: 'q55-0044', tier: 'externally-authored', author: AUTHOR,
    text: 'Protein modeling integration work',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113', 'companies/delta-3'] },
    tags: ['topic-only'] },

  // ─── Natural-language "tell me about..." long form ───────────────
  { id: 'q55-0045', tier: 'externally-authored', author: AUTHOR,
    text: 'Can you tell me about the Forge team structure and how they think about hiring?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['companies/forge-19', 'people/adam-lee-19'] },
    tags: ['long-form'] },
  { id: 'q55-0046', tier: 'externally-authored', author: AUTHOR,
    text: "I want to understand Alice Davis's advisory approach and her involvement at Prism",
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172', 'companies/prism-43'] },
    tags: ['long-form', 'multi-entity'] },

  // ─── Temporal / as-of queries (forces validator to require as_of_date) ─
  { id: 'q55-0047', tier: 'externally-authored', author: AUTHOR,
    text: 'Was Alice Davis renewing her advisory contract with Prism recently?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice-davis-172'] },
    as_of_date: 'corpus-end',
    tags: ['temporal'] },
  { id: 'q55-0048', tier: 'externally-authored', author: AUTHOR,
    text: 'When did Forge close their Series A?',
    expected_output_type: 'time-qualified-answer',
    gold: { expected_answer: '2024-06-19' },
    as_of_date: 'corpus-end',
    tags: ['temporal', 'exact-date'] },
  { id: 'q55-0049', tier: 'externally-authored', author: AUTHOR,
    text: 'What was Adam Lopez doing before he joined Delta?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lopez-113'] },
    as_of_date: 'per-source',
    tags: ['temporal', 'biographical'] },

  // ─── "Give me a short summary" minimal output ────────────────────
  { id: 'q55-0050', tier: 'externally-authored', author: AUTHOR,
    text: 'Short summary of Adam Lee',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/adam-lee-19'] },
    tags: ['summary-request'] },
];

export function getTier5_5SyntheticQueries(): Query[] {
  return TIER5_5_SYNTHETIC_QUERIES.map(q => ({
    ...q,
    gold: { ...q.gold },
    tags: q.tags ? [...q.tags] : undefined,
  }));
}
