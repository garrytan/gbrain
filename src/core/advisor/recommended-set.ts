/**
 * advisor/recommended-set.ts — the bundled skills the advisor + the post-install
 * advisory recommend a user install.
 *
 * CURRENT-STATE ONLY (eng-review Q1): this is a single list of what should be
 * installed now, NOT a release-keyed `Record<release, skills[]>` append-only
 * table. Per-release append-only structures are exactly the anti-pattern
 * CLAUDE.md forbids (they bloated CLAUDE.md to 147k tokens); release attribution
 * for a skill lives in git/CHANGELOG, not here. When the bundled set changes,
 * edit THIS list to the new truth.
 */

export interface RecommendedSkill {
  slug: string;
  description: string;
}

export const RECOMMENDED: RecommendedSkill[] = [
  {
    slug: 'book-mirror',
    description:
      'FLAGSHIP. Take any book (EPUB/PDF), produce a personalized two-column chapter-by-chapter analysis that maps every idea to your life using brain context.',
  },
  {
    slug: 'article-enrichment',
    description:
      'Turn raw article dumps into structured pages with executive summary, verbatim quotes, key insights, and why-it-matters.',
  },
  {
    slug: 'strategic-reading',
    description:
      'Read a book / article / case study through ONE specific problem-lens. Output: an applied playbook with do / avoid / watch-for.',
  },
  {
    slug: 'concept-synthesis',
    description:
      'Deduplicate raw concept stubs into a tiered intellectual map (T1 Canon to T4 Riff). Trace idea evolution across years.',
  },
  {
    slug: 'perplexity-research',
    description:
      'Brain-augmented web research. Sends brain context to the search so it focuses on what is NEW vs already-known.',
  },
  {
    slug: 'archive-crawler',
    description:
      'Universal archivist for personal file archives. REFUSES to run without a gbrain.yml allow-list — safe-by-default.',
  },
  {
    slug: 'academic-verify',
    description:
      'Trace a research claim through publication → methodology → raw data → independent replication. Verdict-shaped brain page.',
  },
  {
    slug: 'brain-pdf',
    description: 'Render any brain page to publication-quality PDF via the gstack make-pdf binary.',
  },
  {
    slug: 'voice-note-ingest',
    description:
      'Capture voice notes with EXACT-PHRASING preservation (never paraphrased). Routes content to the right page types.',
  },
];

/** The current recommended set. (Param kept for call-site compatibility.) */
export function currentRecommendedSet(): RecommendedSkill[] {
  return RECOMMENDED;
}
