/**
 * The judgment input a fixture pair becomes: both participants through the
 * production builder (`judgmentParticipant` in
 * src/core/content-repair/judgment.ts: frontmatter as written, headings,
 * the first 60 non-blank body lines, later lines mentioning the other slug),
 * with the hold code the lane passes. So the eval sends exactly what the
 * product sends; identity evidence past line 60 reaches the model only
 * through `mentions`, which is what the late-evidence fixtures test. Pure.
 */
import { JUDGMENT_HEAD_LINES, judgmentParticipant, type JudgmentInput } from '../../src/core/content-repair/judgment.ts';
import type { Fixture } from './generate-fixtures.ts';

export const HEAD_LINES = JUDGMENT_HEAD_LINES;
export type { JudgmentInput, JudgmentParticipant } from '../../src/core/content-repair/judgment.ts';

export function judgmentInput(f: Fixture): JudgmentInput {
  return {
    held: judgmentParticipant({ path: f.held.path, slug: f.held.slug, content: f.held.content, otherSlug: f.named?.slug ?? null }),
    named: f.named ? judgmentParticipant({ path: f.named.path, slug: f.named.slug, content: f.named.content, otherSlug: f.held.slug }) : null,
    reason: 'frontmatter_slug_conflict',
  };
}
