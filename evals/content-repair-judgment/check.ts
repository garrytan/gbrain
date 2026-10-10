/**
 * The $0 fixture checks (harness `--check` and the keyless test): the set
 * counts plan section 4 fixes, unique ids, placeholder names only, every
 * held file's declared slug is the named page's slug and not its own, a true
 * duplicate's canonical is one of the two slugs, and every fixture tagged
 * `late_note` or `late_evidence` keeps its identity evidence out of the
 * first 60 body lines and inside `mentions` (otherwise the fixture does not
 * test what it claims). Pure.
 */
import type { Fixture } from './generate-fixtures.ts';
import { judgmentInput } from './input.ts';

export const SET_COUNTS: Record<Fixture['set'], number> = { true_duplicate: 25, stray_slug: 10, adversarial: 8, ambiguous: 5 };

/** Slug segments a fixture may use for a person, company or fund: placeholders only. */
const PLACEHOLDER_SEGMENT = /^(?:(?:[a-z]+-)+example(?:-[a-z0-9-]+)?|widget-?co|fund-[a-c]|\d{4}-\d{2}-\d{2}-[a-z-]+)$/;

export function checkFixtures(fixtures: readonly Fixture[]): string[] {
  const out: string[] = [];
  if (new Set(fixtures.map(f => f.id)).size !== fixtures.length) out.push('duplicate fixture ids');
  for (const [set, n] of Object.entries(SET_COUNTS)) {
    const have = fixtures.filter(f => f.set === set).length;
    if (have !== n) out.push(`${set}: ${have} fixtures, plan section 4 fixes ${n}`);
  }
  for (const f of fixtures) {
    const input = judgmentInput(f);
    for (const file of [f.held, f.named].filter((x): x is NonNullable<typeof x> => x !== null)) {
      const [kind, ...rest] = file.slug.split('/');
      if (['people', 'companies', 'funds'].includes(kind!) && !rest.every(seg => PLACEHOLDER_SEGMENT.test(seg))) out.push(`${f.id}: ${file.path} is not a placeholder name`);
    }
    if (f.named && input.held.frontmatter.slug !== f.named.slug) out.push(`${f.id}: the held file's slug line names ${input.held.frontmatter.slug ?? 'nothing'}, the named page is ${f.named.slug}`);
    if (input.held.frontmatter.slug === f.held.slug) out.push(`${f.id}: the held file's slug line names itself (exempt in production)`);
    if (f.set === 'true_duplicate' ? !(f.canonical === f.held.slug || f.canonical === f.named?.slug) : f.canonical !== null) out.push(`${f.id}: canonical ${f.canonical} is not one of the pair`);
    const late = f.tags.includes('late_note') || f.tags.includes('late_evidence');
    const heads = [...input.held.head_lines, ...(input.named?.head_lines ?? [])];
    const mentions = [...input.held.mentions, ...(input.named?.mentions ?? [])];
    if (late && mentions.length === 0) out.push(`${f.id}: tagged late but no line past the head mentions the other page`);
    if (late && heads.some(line => /Duplicate of|Not the same|Distinct from/.test(line))) out.push(`${f.id}: tagged late but the identity evidence sits in the first ${input.held.head_lines.length} lines`);
    if (!late && mentions.length) out.push(`${f.id}: not tagged late but ${mentions.length} line(s) past the head mention the other page`);
  }
  return out;
}
