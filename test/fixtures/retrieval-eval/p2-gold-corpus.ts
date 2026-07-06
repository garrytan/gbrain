import { readFileSync } from 'fs';
import type { BrainEngine } from '../../../src/core/engine.ts';
import type {
  RetrievalEvalCaseInput,
  RetrievalEvalFixtureInput,
} from '../../../src/core/evaluation/retrieval-eval.ts';
import { importFromContent } from '../../../src/core/import-file.ts';

/**
 * Seeded corpus for the P2 gold retrieval fixture (EV-1b).
 *
 * Every gold slug referenced by test/fixtures/retrieval-eval/p2-gold.jsonl is
 * created here on a fresh engine, together with the non-page memory the routed
 * cases need: a profile memory entry for the personal_profile_lookup case, a
 * personal episode entry for the episode case, and a task thread for the
 * task_resume case. Content and titles are written so deterministic keyword
 * retrieval (embeddings unavailable) can answer each fixture query.
 */

export const P2_GOLD_FIXTURE_URL = new URL('./p2-gold.jsonl', import.meta.url);
export const P2_GOLD_TASK_ID = 'mbrain-wave-hardening-complete';
export const P2_GOLD_PROFILE_SUBJECT = 'user preferences';
export const P2_GOLD_PROFILE_SCOPE_ID = 'personal:default';
export const P2_GOLD_EPISODE_TITLE = 'mbrain PR follow-through';

const SOURCE_LINE = '[Source: User, direct message, 2026-07-04 12:00 KST]';

interface P2GoldPage {
  slug: string;
  type: string;
  title: string;
  body: string[];
}

const P2_GOLD_PAGES: P2GoldPage[] = [
  {
    slug: 'brain/systems/mbrain',
    type: 'system',
    title: 'MBrain Knowledge and Retrieval System',
    body: [
      'MBrain is the personal knowledge system whose wave hardening effort this corpus audits.',
      'Hybrid search in mbrain combines keyword recall and vector recall before canonical reads.',
      'retrieve_context returns required_reads pointers while read_context stays the answer evidence contract.',
      '레벨리온 아키텍처 검색 동작은 mbrain 한국어 검색 경로로 검증한다.',
      'Compile debt counts the newest uncompiled timeline entries for ranking.',
      'Auto promote must not strand staged_for_review candidates; stranded candidate repair is a governance duty.',
      'The nightly memory report is the primary review surface and its delivery targets the configured brain dir.',
      'A watched question probe failure should appear in the same nightly report.',
      'Schema drift returns structured get_health remediation instead of raw SQL error text.',
      'The review server verify route requires a bearer session secret with origin and host protection.',
      'pgvector HNSW legs order by embedding distance ascending.',
      'Retrieval source_rank_rules apply to retrieve_context candidate ranking.',
      'known_subjects variants respect the global candidate query variant cap.',
      'updated_after and updated_before thread temporal filters with a recency tiebreak.',
      'Canonical handoff candidate ids with missing completed data count as incomplete debt and fail closed.',
      'Expired write session fallback preserves evidence_kind for source_extracted evidence.',
      'Dream phase timeout handling observes an abandoned promise rejection that must be handled.',
      'Runner gated recompile in the dream phase never appends raw timeline into compiled truth; no timeline append.',
      'Memory report debt sections compute true totals, showing N of M backlog.',
      'Eval retrieval compare emits baseline per route delta output.',
      'EV-2 retrieval trajectory J groundedness derives from EV-1 recall.',
      'Operations declare an explicit tier that replaces admin name fragments.',
      'The per operation doc contract flags undocumented non admin ops.',
      'check backlinks runs superseded_by target validation.',
      'PGLite parity timeout budget covers macOS default test suite cold starts.',
      'VERSION changelog and migration file requirements cover wave release recovery.',
      'review_local mcp reuses the bounded request body instead of a double body read.',
      "Implementation requests apply the user's preference for the end-to-end workflow in this repository task.",
      'Resume the wave hardening branch from the previous handoff worktree.',
    ],
  },
  {
    slug: 'brain/concepts/hybrid-search',
    type: 'concept',
    title: 'Hybrid Search',
    body: [
      'How does hybrid search combine keyword and vector recall in mbrain?',
      'Hybrid retrieval combines keyword and vector evidence and returns canonical reads before answering.',
    ],
  },
  {
    slug: 'brain/concepts/selector-first-retrieval',
    type: 'concept',
    title: 'Selector-First Evidence Contract',
    body: [
      'retrieve_context required_reads answer evidence contract: retrieve_context returns pointers and read_context remains the evidence boundary.',
    ],
  },
  {
    slug: 'brain/concepts/rebellion-architecture',
    type: 'concept',
    title: '레벨리온 아키텍처',
    body: [
      '레벨리온 아키텍처 검색 동작은 CJK AND 의미론을 엔진 전반에서 보존해야 한다.',
      'Korean multi-term retrieval preserves CJK AND semantics across engines.',
    ],
  },
  {
    slug: 'brain/concepts/compiled-truth',
    type: 'concept',
    title: 'Compile Debt and Runner Gated Recompile',
    body: [
      'Compile debt should count timeline entries newer than compiled truth and age from the newest uncompiled entry for ranking.',
      'Runner gated recompile is a dream phase duty with no timeline append into compiled truth.',
    ],
  },
  {
    slug: 'brain/concepts/memory-governance',
    type: 'concept',
    title: 'Memory Governance: Auto Promote, Canonical Handoff, Write Session Fallback, Superseded_by Backlinks',
    body: [
      'Auto promote staged_for_review stranded candidate repair: advance and promote must be atomic.',
      'The nightly memory report is the primary review surface; delivery writes to the configured brain dir and surfaces actionable governance debt.',
      'Completed canonical handoff candidate ids with missing data are incomplete debt and fail closed.',
      'Expired write session fallback must preserve evidence_kind and never promote source_extracted evidence to manual direct statements.',
      'Memory report debt sections compute the true total backlog, showing N of M instead of the latest touched rows.',
      'check backlinks and lint run superseded_by target validation so typos cannot silently demote pages.',
    ],
  },
  {
    slug: 'brain/concepts/watched-questions',
    type: 'concept',
    title: 'Watched Questions',
    body: [
      'A watched question probe failure should appear in the same report, captured per question.',
    ],
  },
  {
    slug: 'brain/concepts/schema-migrations',
    type: 'concept',
    title: 'Schema Drift Remediation',
    body: [
      'Schema drift means get_health returns a structured out-of-date remediation instead of a raw SQL error.',
    ],
  },
  {
    slug: 'brain/concepts/local-review-security',
    type: 'concept',
    title: 'Local Review Security',
    body: [
      'The mbrain review verify route needs bearer origin host protection: mutation routes require a session secret and reject Origin or Host mismatches.',
      'review_local mcp must reuse the bounded request body when falling through to /mcp, never a double body read.',
    ],
  },
  {
    slug: 'brain/concepts/vector-search',
    type: 'concept',
    title: 'Vector Search: pgvector HNSW',
    body: [
      'pgvector HNSW legs order by embedding distance ascending so the index can satisfy the query.',
    ],
  },
  {
    slug: 'brain/concepts/retrieval-ranking',
    type: 'concept',
    title: 'Retrieval Ranking: Source Rank Rules, Recency Tiebreak',
    body: [
      'Retrieval source_rank_rules shape retrieve_context candidate ranking, not only search and query.',
      'retrieve_context threads updated_after and updated_before recency filters to candidate search and uses recency as a tiebreak.',
    ],
  },
  {
    slug: 'brain/concepts/retrieval-routing',
    type: 'concept',
    title: 'Retrieval Routing: Known Subjects Variant Cap',
    body: [
      'known_subjects candidate query variant cap: known subject variants respect the same global candidate-query cap as generated variants.',
    ],
  },
  {
    slug: 'brain/profiles/user',
    type: 'profile',
    title: 'User Preferences Profile',
    body: [
      'What does the user prefer for mbrain implementation requests? End-to-end follow-through: worktree, PR, validation, review, and merge.',
      "Apply the user's mbrain PR workflow preference when a repository task calls for it.",
    ],
  },
  {
    slug: 'brain/episodes/mbrain-pr-follow-through',
    type: 'episode',
    title: 'Merge PRs Follow-Through',
    body: [
      'When did the user ask to merge mbrain PRs after review? The user asked repeatedly to carry mbrain PR work through CI, merge, and cleanup.',
    ],
  },
  {
    slug: 'brain/tasks/mbrain-wave-hardening-complete',
    type: 'task',
    title: 'MBrain Wave Hardening Completion',
    body: [
      'Resume the wave hardening branch from the previous handoff.',
      'Task resume recovers the current branch, worktree, completed items, open items, and next verification steps.',
    ],
  },
  {
    slug: 'brain/concepts/autopilot',
    type: 'concept',
    title: 'Autopilot: Dream Phase Timeout Handling',
    body: [
      'A dream phase timeout leaves an abandoned promise; the rejection must be handled and timeout streaks reported.',
    ],
  },
  {
    slug: 'brain/concepts/evaluation',
    type: 'concept',
    title: 'Retrieval Eval Baselines and Trajectory Groundedness',
    body: [
      'Eval retrieval compare shows baseline and head deltas, including a per route delta.',
      'EV-2 retrieval trajectory J groundedness comes from EV-1 recall so J can become positive when quality is good.',
    ],
  },
  {
    slug: 'brain/concepts/operation-contract',
    type: 'concept',
    title: 'Operation Tier and Doc Contract',
    body: [
      'Operations declare an explicit tier that replaces admin name fragments.',
      'The per operation doc contract requires every non admin op to be documented or annotated; undocumented non admin ops fail the check.',
    ],
  },
  {
    slug: 'brain/concepts/test-suite',
    type: 'concept',
    title: 'PGLite Parity Test Suite',
    body: [
      'PGLite parity timeout budget must cover macOS cold starts in the default test suite without loosening assertions.',
    ],
  },
  {
    slug: 'brain/concepts/release-hygiene',
    type: 'concept',
    title: 'Release Hygiene: VERSION Changelog Migration File',
    body: [
      'VERSION changelog migration file wave release recovery: schema-affecting waves need a version bump, changelog entries, and migration instructions.',
    ],
  },
];

export async function seedP2GoldCorpus(engine: BrainEngine): Promise<void> {
  for (const page of P2_GOLD_PAGES) {
    const content = [
      '---',
      `type: ${page.type}`,
      `title: ${JSON.stringify(page.title)}`,
      '---',
      ...page.body,
      SOURCE_LINE,
    ].join('\n');
    const result = await importFromContent(engine, page.slug, content, { path: `${page.slug}.md` });
    if (result.status === 'error') {
      throw new Error(`Failed to seed P2 gold page ${page.slug}: ${result.error ?? 'unknown error'}`);
    }
  }

  await engine.upsertProfileMemoryEntry({
    id: 'p2-gold-profile-user-preferences',
    scope_id: P2_GOLD_PROFILE_SCOPE_ID,
    profile_type: 'preference',
    subject: P2_GOLD_PROFILE_SUBJECT,
    content: 'For mbrain implementation work, the user prefers end-to-end worktree, PR, validation, review, and merge follow-through.',
    source_refs: ['page:brain/profiles/user'],
    sensitivity: 'personal',
    export_status: 'private_only',
  });

  await engine.createPersonalEpisodeEntry({
    id: 'p2-gold-episode-pr-follow-through',
    scope_id: P2_GOLD_PROFILE_SCOPE_ID,
    title: P2_GOLD_EPISODE_TITLE,
    start_time: '2026-07-01T09:00:00Z',
    source_kind: 'chat',
    summary: 'The user asked to carry mbrain PR work through review, CI, merge, and cleanup.',
    source_refs: ['page:brain/episodes/mbrain-pr-follow-through'],
    candidate_ids: [],
  });

  await engine.createTaskThread({
    id: P2_GOLD_TASK_ID,
    scope: 'work',
    title: 'MBrain wave hardening completion',
    goal: 'Carry the wave hardening branch through review, validation, and merge.',
    status: 'active',
    repo_path: '/work/mbrain',
    branch_name: 'wave-hardening',
    current_summary: 'Resume from the previous handoff: verify open items and next verification steps.',
  });
}

export function loadP2GoldFixture(fixtureId = 'p2-gold'): RetrievalEvalFixtureInput {
  const cases = readFileSync(P2_GOLD_FIXTURE_URL, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RetrievalEvalCaseInput);
  return { fixture_id: fixtureId, cases };
}
