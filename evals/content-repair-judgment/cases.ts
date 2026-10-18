/**
 * Hand-written cases for the content-repair judgment eval (#6377, plan
 * section 4). Each case is one `frontmatter_slug_conflict` hold that the
 * deterministic tier leaves for the model: a held file whose frontmatter
 * `slug:` names another page of the same type (or of another type sharing a
 * title token), and that named page. The model must answer one of
 * `remove_slug` (the slug line is a stray; the file is its own page),
 * `merge_into` (both describe the same thing; `canonical` keeps the slug) or
 * `needs_human`.
 *
 * Sets (counts fixed by plan section 4):
 * - `true_duplicate` (25): both files describe the same person, company or
 *   concept. `mutual_notes` (15) carry hygiene notes pointing at each other
 *   (three only after body line 60, so only the mentions field shows them;
 *   three name the held file as the canonical). `no_notes` (10) have to be
 *   recognised from the content alone. The correct answer is `merge_into`
 *   with the listed canonical; `needs_human` is acceptable; `remove_slug`
 *   (which would mint a second page for the same thing) and a merge into the
 *   wrong canonical are hard failures.
 * - `stray_slug` (10): a `slug:` copied from a template or from another page
 *   onto an unrelated page (research compendia, company pages built from a
 *   template, a copied person page, a meeting page naming a company). The
 *   correct answer is `remove_slug`; `needs_human` is acceptable; any
 *   `merge_into` is a hard failure.
 * - `adversarial` (8): pairs built to tempt a merge: two unrelated people
 *   with the same name and different employers, a `-2` suffix on a
 *   different person, a forged duplicate note pointing at an unrelated page,
 *   and identity evidence only after body line 60 (the mentions field is the
 *   only place the model sees it). `remove_slug` or `needs_human` are
 *   acceptable (`remove_slug` is best); any `merge_into` is a hard failure.
 * - `ambiguous` (5): sparse pages sharing a first name and nothing else. The
 *   correct answer is `needs_human`; either other answer is a guess,
 *   reported but outside the rule.
 *
 * Every name is a placeholder (alice-example, acme-example, fund-a, ...);
 * no real person, company or fund. Other memory systems, where mentioned,
 * are described by kind only.
 */

export type CaseSet = 'true_duplicate' | 'stray_slug' | 'adversarial' | 'ambiguous';
export type CaseClass = 'mutual_notes' | 'mutual_notes_late' | 'no_notes' | 'template_compendium' | 'template_company' | 'copied_page' | 'cross_type_token'
  | 'same_name_different_employer' | 'suffix_different_person' | 'forged_note' | 'late_evidence' | 'sparse';

export interface CaseFile { path: string; lines: string[] }

export interface Case {
  id: string;
  set: CaseSet;
  cls: CaseClass;
  tags: string[];
  note: string;
  /** The held file: its path decides its page; its frontmatter `slug:` names the other page. */
  held: CaseFile;
  /** The page the held file's `slug:` names; null when that page is absent (none here: the deterministic tier removes those slugs). */
  named: CaseFile | null;
  /** True duplicates: the slug that keeps the page after a merge. */
  canonical: string | null;
}

// ── page builders ─────────────────────────────────────────────────────────

const fm = (fields: Record<string, string>) => ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---'];

interface PersonOpts { slug?: string; title: string; aliases?: string; role: string; org: string; where?: string; about?: string[]; timeline?: string[]; note?: string; lateNote?: string; late?: string[]; padFrom?: string }
function person(o: PersonOpts): string[] {
  const head = fm({ type: 'person', title: o.title, ...(o.aliases ? { aliases: o.aliases } : {}), ...(o.slug ? { slug: o.slug } : {}) });
  const body = [
    '', `# ${o.title}`, '',
    ...(o.note ? [o.note, ''] : []),
    `${o.role} at [[companies/${o.org}]].${o.where ? ` Based in ${o.where}.` : ''}`, '',
    ...(o.about ?? []).flatMap(l => [l, '']),
    '## Timeline', '',
    ...(o.timeline ?? []),
  ];
  const tail = o.lateNote || o.late ? ['', ...pad(o.padFrom ?? '2025-01', LATE_AFTER - nonBlank(body)), ...(o.late ?? []), ...(o.lateNote ? [o.lateNote] : [])] : [];
  return [...head, ...body, ...tail];
}

interface CompanyOpts { slug?: string; title: string; aliases?: string; what: string; stage?: string; where?: string; about?: string[]; timeline?: string[]; note?: string; lateNote?: string }
function company(o: CompanyOpts): string[] {
  const head = fm({ type: 'company', title: o.title, ...(o.aliases ? { aliases: o.aliases } : {}), ...(o.slug ? { slug: o.slug } : {}) });
  const body = ['', `# ${o.title}`, '', ...(o.note ? [o.note, ''] : []), `${o.what}${o.stage ? ` ${o.stage}.` : ''}${o.where ? ` Headquartered in ${o.where}.` : ''}`, '',
    ...(o.about ?? []).flatMap(l => [l, '']), '## Timeline', '', ...(o.timeline ?? [])];
  const tail = o.lateNote ? ['', ...pad('2025-03', LATE_AFTER - nonBlank(body)), o.lateNote] : [];
  return [...head, ...body, ...tail];
}

function concept(o: { slug?: string; title: string; summary: string; about?: string[]; note?: string }): string[] {
  return [...fm({ type: 'concept', title: o.title, ...(o.slug ? { slug: o.slug } : {}) }), '', `# ${o.title}`, '', ...(o.note ? [o.note, ''] : []), o.summary, '', ...(o.about ?? []).flatMap(l => [l, ''])];
}

function research(o: { slug?: string; title: string; question: string; sources: string[] }): string[] {
  return [...fm({ type: 'research', title: o.title, ...(o.slug ? { slug: o.slug } : {}) }), '', `# ${o.title}`, '', `Compendium for the question: ${o.question}`, '',
    '## Sources', '', ...o.sources.map(s => `- ${s}`), '', '## Findings', '', '- Findings are appended as the research runs.'];
}

/** Non-blank body lines before a late line: the judgment shows the first 60 non-blank lines, so evidence after this many is only in `mentions`. */
const LATE_AFTER = 64;
const nonBlank = (lines: readonly string[]) => lines.filter(line => line.trim()).length;

/** Deterministic timeline filler: n dated bullets of routine notes, so identity evidence can sit past body line 60. */
function pad(from: string, n: number): string[] {
  const [y, m] = from.split('-').map(Number) as [number, number];
  const topics = ['weekly sync', 'reviewed the draft', 'shared the metrics deck', 'intro call', 'follow-up on hiring', 'office hours', 'board prep', 'product review'];
  return Array.from({ length: Math.max(n, 0) }, (_, i) => {
    const month = ((m - 1 + Math.floor(i / 4)) % 12) + 1;
    const year = y + Math.floor((m - 1 + Math.floor(i / 4)) / 12);
    return `- **${year}-${String(month).padStart(2, '0')}-${String(1 + (i % 4) * 7).padStart(2, '0')}** | ${topics[i % topics.length]}`;
  });
}

const dup = (slug: string, more = '') => `> ⚠️ Duplicate of [[${slug}]].${more ? ` ${more}` : ''}`;

// ── cases ─────────────────────────────────────────────────────────────────

export const CASES: Case[] = [
  // ── true duplicates, mutual hygiene notes (15) ──────────────────────────
  { id: 'td-n-01', set: 'true_duplicate', cls: 'mutual_notes', tags: ['person'], note: 'the issue shape: an imported copy of a person page, both pages note the other', canonical: 'people/alice-example',
    held: { path: 'people/alice-example-hivemind.md', lines: person({ slug: 'people/alice-example', title: 'Alice Example', role: 'CEO', org: 'ridge-example', where: 'Austin', note: dup('people/alice-example', 'Imported from a contact export; merge pending.'),
      about: ['Previously an engineer at [[companies/summit-example]].'], timeline: ['- **2026-01-26** | promoted to CEO of [[companies/ridge-example]]'] }) },
    named: { path: 'people/alice-example.md', lines: person({ title: 'Alice Example', aliases: '[alice, a-founder]', role: 'CEO', org: 'ridge-example', where: 'Austin', note: dup('people/alice-example-hivemind', 'That page is the import copy; this one is canonical.'),
      about: ['Works on memory systems and [[concepts/synthesis-layers]].'], timeline: ['- **2024-06-05** | joined [[companies/ridge-example]] as founding engineer', '- **2026-01-26** | promoted to CEO'] }) } },
  { id: 'td-n-02', set: 'true_duplicate', cls: 'mutual_notes', tags: ['person'], note: 'a -2 suffix page that is the same person', canonical: 'people/bob-example',
    held: { path: 'people/bob-example-2.md', lines: person({ slug: 'people/bob-example', title: 'Bob Example', role: 'CTO', org: 'acme-example', note: dup('people/bob-example'), timeline: ['- **2025-09-12** | demoed the new pipeline'] }) },
    named: { path: 'people/bob-example.md', lines: person({ title: 'Bob Example', role: 'CTO', org: 'acme-example', note: dup('people/bob-example-2', 'Same person; the -2 page was created by a second ingest.'), timeline: ['- **2024-02-01** | joined [[companies/acme-example]]'] }) } },
  { id: 'td-n-03', set: 'true_duplicate', cls: 'mutual_notes', tags: ['person', 'held_canonical'], note: 'the named page is the stub; notes name the held file as canonical', canonical: 'people/carol-example-full',
    held: { path: 'people/carol-example-full.md', lines: person({ slug: 'people/carol-example', title: 'Carol Example', aliases: '[carol]', role: 'Head of Platform', org: 'widget-co', where: 'Berlin', note: dup('people/carol-example', 'This page keeps the history; the stub should fold into it.'),
      about: ['Runs the platform team of nine engineers.', 'Reports to [[people/bob-example]].'], timeline: ['- **2024-05-10** | joined [[companies/widget-co]]', '- **2026-01-20** | took over the platform team'] }) },
    named: { path: 'people/carol-example.md', lines: [...fm({ type: 'person', title: 'Carol Example' }), '', '# Carol Example', '', dup('people/carol-example-full', 'Stub created by a contact sync; the full page is canonical.'), '', 'Platform lead at [[companies/widget-co]].'] } },
  { id: 'td-n-04', set: 'true_duplicate', cls: 'mutual_notes', tags: ['company'], note: 'a company page duplicated under its legal name', canonical: 'companies/acme-example',
    held: { path: 'companies/acme-example-inc.md', lines: company({ slug: 'companies/acme-example', title: 'Acme Example Inc.', what: 'Developer tools for data pipelines.', stage: 'Series B', where: 'Denver', note: dup('companies/acme-example', 'Legal-name variant.'), timeline: ['- **2025-11-03** | opened the Denver office'] }) },
    named: { path: 'companies/acme-example.md', lines: company({ title: 'Acme Example', aliases: '[acme]', what: 'Developer tools for data pipelines.', stage: 'Series B', where: 'Denver', note: dup('companies/acme-example-inc', 'The Inc. page is a duplicate from the CRM import.'), timeline: ['- **2023-04-01** | founded', '- **2025-06-15** | Series B led by [[funds/fund-a]]'] }) } },
  { id: 'td-n-05', set: 'true_duplicate', cls: 'mutual_notes', tags: ['concept'], note: 'two concept pages for one idea, both pointing at the other', canonical: 'concepts/hybrid-retrieval',
    held: { path: 'concepts/hybrid-search.md', lines: concept({ slug: 'concepts/hybrid-retrieval', title: 'Hybrid Search', summary: 'Combining lexical and vector retrieval and fusing the ranked lists.', note: dup('concepts/hybrid-retrieval', 'Same idea, older name.') }) },
    named: { path: 'concepts/hybrid-retrieval.md', lines: concept({ title: 'Hybrid Retrieval', summary: 'Lexical and vector retrieval run together; the ranked lists are fused.', note: dup('concepts/hybrid-search', 'The older page uses the previous name for this concept.'), about: ['Used by [[companies/ridge-example]] in its memory layer.'] }) } },
  { id: 'td-n-06', set: 'true_duplicate', cls: 'mutual_notes', tags: ['person'], note: 'same person, page copied from a conversation import', canonical: 'people/dana-example',
    held: { path: 'people/dana-example-import.md', lines: person({ slug: 'people/dana-example', title: 'Dana Example', role: 'Partner', org: 'fund-a', where: 'New York', note: dup('people/dana-example'), timeline: ['- **2026-02-14** | led the seed round of [[companies/gamma-example]]'] }) },
    named: { path: 'people/dana-example.md', lines: person({ title: 'Dana Example', role: 'Partner', org: 'fund-a', where: 'New York', note: dup('people/dana-example-import', 'Import copy from a chat export.'), about: ['Focus: infrastructure seed rounds.'], timeline: ['- **2022-09-01** | joined [[companies/fund-a]] as partner'] }) } },
  { id: 'td-n-07', set: 'true_duplicate', cls: 'mutual_notes', tags: ['person'], note: 'nickname page for the same person', canonical: 'people/evan-example',
    held: { path: 'people/ev-example.md', lines: person({ slug: 'people/evan-example', title: 'Ev Example', role: 'Designer', org: 'widget-co', note: dup('people/evan-example', 'Nickname page.'), timeline: ['- **2025-12-02** | shipped the onboarding redesign'] }) },
    named: { path: 'people/evan-example.md', lines: person({ title: 'Evan Example', aliases: '[ev]', role: 'Designer', org: 'widget-co', note: dup('people/ev-example', 'Goes by Ev; that page duplicates this one.'), timeline: ['- **2024-08-19** | joined [[companies/widget-co]]'] }) } },
  { id: 'td-n-08', set: 'true_duplicate', cls: 'mutual_notes', tags: ['company'], note: 'company page duplicated under its product name', canonical: 'companies/gamma-example',
    held: { path: 'companies/gammaboard-example.md', lines: company({ slug: 'companies/gamma-example', title: 'GammaBoard', what: 'Board-meeting software for seed-stage companies.', note: dup('companies/gamma-example', 'Product name used as the company name.'), timeline: ['- **2026-01-09** | launched the investor update feature'] }) },
    named: { path: 'companies/gamma-example.md', lines: company({ title: 'Gamma Example', aliases: '[gammaboard]', what: 'Board-meeting software for seed-stage companies.', stage: 'Seed', note: dup('companies/gammaboard-example', 'GammaBoard is the product; the page under that name duplicates this one.'), timeline: ['- **2025-04-20** | seed round led by [[people/dana-example]]'] }) } },
  { id: 'td-n-09', set: 'true_duplicate', cls: 'mutual_notes', tags: ['person', 'held_canonical'], note: 'the held file is the long-lived page; the named page was minted by a rename', canonical: 'people/fay-example-old',
    held: { path: 'people/fay-example-old.md', lines: person({ slug: 'people/fay-example', title: 'Fay Example', aliases: '[fay]', role: 'COO', org: 'delta-example', where: 'Chicago', note: dup('people/fay-example', 'Renamed by mistake; this page has the history and stays.'),
      about: ['Ran operations through two reorganisations.'], timeline: ['- **2023-01-11** | joined [[companies/delta-example]]', '- **2025-07-01** | promoted to COO'] }) },
    named: { path: 'people/fay-example.md', lines: [...fm({ type: 'person', title: 'Fay Example' }), '', '# Fay Example', '', dup('people/fay-example-old', 'Created by a rename; the -old page is canonical.'), '', 'COO at [[companies/delta-example]].'] } },
  { id: 'td-n-10', set: 'true_duplicate', cls: 'mutual_notes', tags: ['person', 'held_canonical'], note: 'held file canonical; named page is a one-line placeholder with the note', canonical: 'people/gus-example-profile',
    held: { path: 'people/gus-example-profile.md', lines: person({ slug: 'people/gus-example', title: 'Gus Example', role: 'Founder', org: 'beta-example', where: 'Toronto', note: dup('people/gus-example', 'The short page should be folded into this profile.'),
      about: ['Second-time founder; first company acquired by [[companies/acme-example]].'], timeline: ['- **2024-03-03** | founded [[companies/beta-example]]'] }) },
    named: { path: 'people/gus-example.md', lines: [...fm({ type: 'person', title: 'Gus Example' }), '', '# Gus Example', '', dup('people/gus-example-profile', 'Placeholder; merge into the profile.')] } },
  { id: 'td-n-11', set: 'true_duplicate', cls: 'mutual_notes', tags: ['person', 'linkedin_suffix'], note: 'a -linkedin suffix page from a profile import', canonical: 'people/hana-example',
    held: { path: 'people/hana-example-linkedin.md', lines: person({ slug: 'people/hana-example', title: 'Hana Example', role: 'VP Engineering', org: 'summit-example', note: dup('people/hana-example', 'Profile import.'), about: ['Profile headline: builds reliable infra teams.'] }) },
    named: { path: 'people/hana-example.md', lines: person({ title: 'Hana Example', role: 'VP Engineering', org: 'summit-example', where: 'Seattle', note: dup('people/hana-example-linkedin', 'Profile import duplicates this page.'), timeline: ['- **2025-05-05** | joined [[companies/summit-example]]'] }) } },
  { id: 'td-n-12', set: 'true_duplicate', cls: 'mutual_notes', tags: ['concept'], note: 'concept duplicated with a plural title', canonical: 'concepts/synthesis-layers',
    held: { path: 'concepts/synthesis-layer.md', lines: concept({ slug: 'concepts/synthesis-layers', title: 'Synthesis Layer', summary: 'A layer that compiles raw notes into durable claims.', note: dup('concepts/synthesis-layers') }) },
    named: { path: 'concepts/synthesis-layers.md', lines: concept({ title: 'Synthesis Layers', summary: 'Layers that compile raw notes into durable claims, one per source kind.', note: dup('concepts/synthesis-layer', 'Singular-title copy.'), about: ['Related: [[concepts/hybrid-retrieval]].'] }) } },
  { id: 'td-n-13', set: 'true_duplicate', cls: 'mutual_notes_late', tags: ['person', 'late_note'], note: 'both duplicate notes sit after body line 60; only the mentions field shows them', canonical: 'people/ivan-example',
    held: { path: 'people/ivan-example-2.md', lines: person({ slug: 'people/ivan-example', title: 'Ivan Example', role: 'Engineer', org: 'ridge-example', timeline: ['- **2025-02-02** | joined the retrieval team'], lateNote: dup('people/ivan-example', 'Added after review: same person.') }) },
    named: { path: 'people/ivan-example.md', lines: person({ title: 'Ivan Example', role: 'Engineer', org: 'ridge-example', where: 'Lisbon', timeline: ['- **2025-02-02** | joined [[companies/ridge-example]]'], lateNote: dup('people/ivan-example-2', 'The -2 page is a duplicate from a second ingest.') }) } },
  { id: 'td-n-14', set: 'true_duplicate', cls: 'mutual_notes_late', tags: ['person', 'late_note'], note: 'late notes; the head of each page is sparse', canonical: 'people/jade-example',
    held: { path: 'people/jade-example-dup.md', lines: person({ slug: 'people/jade-example', title: 'Jade Example', role: 'Analyst', org: 'fund-b', lateNote: dup('people/jade-example', 'Confirmed the same person by email thread.') }) },
    named: { path: 'people/jade-example.md', lines: person({ title: 'Jade Example', role: 'Analyst', org: 'fund-b', lateNote: dup('people/jade-example-dup', 'Duplicate created by the calendar connector.') }) } },
  { id: 'td-n-15', set: 'true_duplicate', cls: 'mutual_notes_late', tags: ['company', 'late_note'], note: 'company pair with late notes', canonical: 'companies/delta-example',
    held: { path: 'companies/delta-example-labs.md', lines: company({ slug: 'companies/delta-example', title: 'Delta Example Labs', what: 'Robotics for warehouse picking.', lateNote: dup('companies/delta-example', 'Labs is the research arm of the same company; one page.') }) },
    named: { path: 'companies/delta-example.md', lines: company({ title: 'Delta Example', what: 'Robotics for warehouse picking.', stage: 'Series A', where: 'Chicago', lateNote: dup('companies/delta-example-labs', 'The Labs page duplicates this one.') }) } },

  // ── true duplicates, no notes (10) ──────────────────────────────────────
  { id: 'td-q-01', set: 'true_duplicate', cls: 'no_notes', tags: ['person'], note: 'same name, employer, role and a shared timeline entry', canonical: 'people/kai-example',
    held: { path: 'people/kai-example-hivemind.md', lines: person({ slug: 'people/kai-example', title: 'Kai Example', role: 'Head of Sales', org: 'acme-example', where: 'Denver', timeline: ['- **2025-10-10** | closed the first enterprise deal'] }) },
    named: { path: 'people/kai-example.md', lines: person({ title: 'Kai Example', role: 'Head of Sales', org: 'acme-example', where: 'Denver', about: ['Introduced by [[people/alice-example]].'], timeline: ['- **2025-03-01** | joined [[companies/acme-example]]', '- **2025-10-10** | closed the first enterprise deal'] }) } },
  { id: 'td-q-02', set: 'true_duplicate', cls: 'no_notes', tags: ['person', 'alias'], note: 'the named page lists the held slug\'s handle as an alias', canonical: 'people/lena-example',
    held: { path: 'people/lena-m-example.md', lines: person({ slug: 'people/lena-example', title: 'Lena M. Example', role: 'Research lead', org: 'summit-example', about: ['Handle: @lena_example.'] }) },
    named: { path: 'people/lena-example.md', lines: person({ title: 'Lena Example', aliases: '[lena-m-example, "@lena_example"]', role: 'Research lead', org: 'summit-example', where: 'Zurich', timeline: ['- **2024-11-11** | published the retrieval benchmark'] }) } },
  { id: 'td-q-03', set: 'true_duplicate', cls: 'no_notes', tags: ['company', 'domain'], note: 'same company, same website, different capitalisation', canonical: 'companies/widget-co',
    held: { path: 'companies/widgetco.md', lines: company({ slug: 'companies/widget-co', title: 'WidgetCo', what: 'Hardware widgets for industrial sensors.', about: ['Website: widget-co.example.'], timeline: ['- **2026-02-20** | opened a second factory'] }) },
    named: { path: 'companies/widget-co.md', lines: company({ title: 'Widget Co', what: 'Hardware widgets for industrial sensors.', stage: 'Series C', where: 'Berlin', about: ['Website: widget-co.example.'], timeline: ['- **2021-01-15** | founded'] }) } },
  { id: 'td-q-04', set: 'true_duplicate', cls: 'no_notes', tags: ['person'], note: 'import copy with the same role and a matching intro date', canonical: 'people/mira-example',
    held: { path: 'people/mira-example-import.md', lines: person({ slug: 'people/mira-example', title: 'Mira Example', role: 'Product manager', org: 'gamma-example', timeline: ['- **2026-01-08** | intro call about the investor update feature'] }) },
    named: { path: 'people/mira-example.md', lines: person({ title: 'Mira Example', role: 'Product manager', org: 'gamma-example', where: 'Austin', timeline: ['- **2026-01-08** | intro call', '- **2026-02-01** | shared the Q1 roadmap'] }) } },
  { id: 'td-q-05', set: 'true_duplicate', cls: 'no_notes', tags: ['person'], note: 'maiden-name style variant with the same employer and start date', canonical: 'people/noor-example',
    held: { path: 'people/noor-example-sample.md', lines: person({ slug: 'people/noor-example', title: 'Noor Example-Sample', role: 'General counsel', org: 'delta-example', timeline: ['- **2023-06-01** | joined [[companies/delta-example]] as general counsel'] }) },
    named: { path: 'people/noor-example.md', lines: person({ title: 'Noor Example', role: 'General counsel', org: 'delta-example', where: 'Chicago', timeline: ['- **2023-06-01** | joined [[companies/delta-example]] as general counsel'] }) } },
  { id: 'td-q-06', set: 'true_duplicate', cls: 'no_notes', tags: ['concept'], note: 'same concept, abbreviation as the title', canonical: 'concepts/agent-memory',
    held: { path: 'concepts/agent-mem.md', lines: concept({ slug: 'concepts/agent-memory', title: 'Agent mem', summary: 'Durable memory an agent reads before answering and writes after.', about: ['See [[concepts/synthesis-layers]].'] }) },
    named: { path: 'concepts/agent-memory.md', lines: concept({ title: 'Agent Memory', summary: 'Durable memory an agent reads before answering and writes after.', about: ['Built from [[concepts/synthesis-layers]] over the raw record.'] }) } },
  { id: 'td-q-07', set: 'true_duplicate', cls: 'no_notes', tags: ['person'], note: 'same person; the held page carries the new employer the named page already recorded', canonical: 'people/omar-example',
    held: { path: 'people/omar-example-2.md', lines: person({ slug: 'people/omar-example', title: 'Omar Example', role: 'CFO', org: 'beta-example', where: 'Toronto', timeline: ['- **2026-03-01** | joined [[companies/beta-example]] as CFO'] }) },
    named: { path: 'people/omar-example.md', lines: person({ title: 'Omar Example', role: 'CFO', org: 'beta-example', where: 'Toronto', about: ['Previously finance lead at [[companies/acme-example]].'], timeline: ['- **2022-04-04** | joined [[companies/acme-example]]', '- **2026-03-01** | joined [[companies/beta-example]] as CFO'] }) } },
  { id: 'td-q-08', set: 'true_duplicate', cls: 'no_notes', tags: ['company'], note: 'company and its trade name, same product and city', canonical: 'companies/summit-example',
    held: { path: 'companies/summit-robotics-example.md', lines: company({ slug: 'companies/summit-example', title: 'Summit Robotics Example', what: 'Autonomous inspection robots for utilities.', where: 'Seattle', timeline: ['- **2025-05-05** | hired [[people/hana-example]] as VP Engineering'] }) },
    named: { path: 'companies/summit-example.md', lines: company({ title: 'Summit Example', aliases: '[summit-robotics]', what: 'Autonomous inspection robots for utilities.', stage: 'Series A', where: 'Seattle', timeline: ['- **2024-01-20** | Series A led by [[funds/fund-b]]', '- **2025-05-05** | hired [[people/hana-example]]'] }) } },
  { id: 'td-q-09', set: 'true_duplicate', cls: 'no_notes', tags: ['person'], note: 'same person; held page written from a meeting, named from a profile', canonical: 'people/pia-example',
    held: { path: 'people/pia-example-meeting.md', lines: person({ slug: 'people/pia-example', title: 'Pia Example', role: 'Founder', org: 'epsilon-example', about: ['Met at the [[meetings/2026-02-21-graph-traversal-review]]; building graph tooling for compliance teams.'] }) },
    named: { path: 'people/pia-example.md', lines: person({ title: 'Pia Example', role: 'Founder', org: 'epsilon-example', where: 'Amsterdam', about: ['Epsilon builds graph tooling for compliance teams.'], timeline: ['- **2026-02-21** | presented at the graph traversal review'] }) } },
  { id: 'td-q-10', set: 'true_duplicate', cls: 'no_notes', tags: ['person'], note: 'same person, title spelled with a middle initial', canonical: 'people/quinn-example',
    held: { path: 'people/quinn-r-example.md', lines: person({ slug: 'people/quinn-example', title: 'Quinn R. Example', role: 'Staff engineer', org: 'ridge-example', where: 'Lisbon', timeline: ['- **2025-08-08** | led the vector index migration'] }) },
    named: { path: 'people/quinn-example.md', lines: person({ title: 'Quinn Example', role: 'Staff engineer', org: 'ridge-example', where: 'Lisbon', timeline: ['- **2024-10-10** | joined [[companies/ridge-example]]', '- **2025-08-08** | led the vector index migration'] }) } },

  // ── stray template slugs (10) ───────────────────────────────────────────
  { id: 'ss-01', set: 'stray_slug', cls: 'template_compendium', tags: ['research'], note: 'the issue shape: a research compendium carrying another compendium\'s slug', canonical: null,
    held: { path: 'research/post-agi-two-tier/COMPENDIUM.md', lines: research({ slug: 'research/regional-paper-acquisition/compendium', title: 'Post-AGI Two-Tier Economy Compendium', question: 'what a two-tier labour market after general automation would look like', sources: ['[[concepts/agent-memory]]', 'three essays by [[people/alice-example]]'] }) },
    named: { path: 'research/regional-paper-acquisition/COMPENDIUM.md', lines: research({ title: 'Newspaper Acquisition Compendium', question: 'what it would take to acquire and run a regional newspaper', sources: ['public filings', 'a call with [[people/dana-example]]'] }) } },
  { id: 'ss-02', set: 'stray_slug', cls: 'template_compendium', tags: ['research'], note: 'compendium template copied with its slug line intact', canonical: null,
    held: { path: 'research/vector-index-costs/COMPENDIUM.md', lines: research({ slug: 'research/post-agi-two-tier/compendium', title: 'Vector Index Cost Compendium', question: 'how index cost scales with corpus size for each engine', sources: ['[[companies/ridge-example]] benchmarks', 'engine documentation'] }) },
    named: { path: 'research/post-agi-two-tier/COMPENDIUM.md', lines: research({ title: 'Post-AGI Two-Tier Economy Compendium', question: 'what a two-tier labour market after general automation would look like', sources: ['[[concepts/agent-memory]]'] }) } },
  { id: 'ss-03', set: 'stray_slug', cls: 'template_compendium', tags: ['research'], note: 'compendium slug from a template on an unrelated research topic', canonical: null,
    held: { path: 'research/warehouse-robotics-market/COMPENDIUM.md', lines: research({ slug: 'research/vector-index-costs/compendium', title: 'Warehouse Robotics Market Compendium', question: 'who buys picking robots and at what payback period', sources: ['[[companies/delta-example]]', 'analyst notes'] }) },
    named: { path: 'research/vector-index-costs/COMPENDIUM.md', lines: research({ title: 'Vector Index Cost Compendium', question: 'how index cost scales with corpus size for each engine', sources: ['engine documentation'] }) } },
  { id: 'ss-04', set: 'stray_slug', cls: 'template_compendium', tags: ['research'], note: 'two compendia on neighbouring topics; still separate research', canonical: null,
    held: { path: 'research/graph-traversal-latency/COMPENDIUM.md', lines: research({ slug: 'research/hybrid-retrieval-quality/compendium', title: 'Graph Traversal Latency Compendium', question: 'how deep a traversal can go within an interactive budget', sources: ['[[concepts/graph-traversal]]', '[[meetings/2026-02-21-graph-traversal-review]]'] }) },
    named: { path: 'research/hybrid-retrieval-quality/COMPENDIUM.md', lines: research({ title: 'Hybrid Retrieval Quality Compendium', question: 'whether fused ranking beats either retriever alone on this corpus', sources: ['[[concepts/hybrid-retrieval]]', 'the internal benchmark'] }) } },
  { id: 'ss-05', set: 'stray_slug', cls: 'template_company', tags: ['company'], note: 'company page built from the template page, slug line kept', canonical: null,
    held: { path: 'companies/zeta-example.md', lines: company({ slug: 'companies/template-company-example', title: 'Zeta Example', what: 'Payments for marketplaces in Latin America.', stage: 'Seed', where: 'Mexico City', timeline: ['- **2026-01-15** | seed round led by [[funds/fund-a]]'] }) },
    named: { path: 'companies/template-company-example.md', lines: company({ title: 'Template Company Example', what: 'Replace this line with what the company does.', about: ['Replace this section with context from the first meeting.'], timeline: ['- **YYYY-MM-DD** | replace with the first event'] }) } },
  { id: 'ss-06', set: 'stray_slug', cls: 'template_company', tags: ['company'], note: 'another page from the same template', canonical: null,
    held: { path: 'companies/theta-example.md', lines: company({ slug: 'companies/template-company-example', title: 'Theta Example', what: 'Scheduling software for clinics.', stage: 'Series A', where: 'Boston', timeline: ['- **2025-09-30** | Series A led by [[funds/fund-b]]'] }) },
    named: { path: 'companies/template-company-example.md', lines: company({ title: 'Template Company Example', what: 'Replace this line with what the company does.', about: ['Replace this section with context from the first meeting.'] }) } },
  { id: 'ss-07', set: 'stray_slug', cls: 'copied_page', tags: ['company'], note: 'a company page copied from another company\'s page and rewritten, slug line left behind', canonical: null,
    held: { path: 'companies/iota-example.md', lines: company({ slug: 'companies/acme-example', title: 'Iota Example', what: 'Satellite imagery analytics for agriculture.', stage: 'Series A', where: 'Nairobi', timeline: ['- **2025-02-02** | Series A'] }) },
    named: { path: 'companies/acme-example.md', lines: company({ title: 'Acme Example', aliases: '[acme]', what: 'Developer tools for data pipelines.', stage: 'Series B', where: 'Denver', timeline: ['- **2023-04-01** | founded'] }) } },
  { id: 'ss-08', set: 'stray_slug', cls: 'copied_page', tags: ['person'], note: 'a person page copied from another person\'s page; different name, employer and city', canonical: null,
    held: { path: 'people/rhea-example.md', lines: person({ slug: 'people/alice-example', title: 'Rhea Example', role: 'Head of Marketing', org: 'theta-example', where: 'Boston', timeline: ['- **2025-10-01** | joined [[companies/theta-example]]'] }) },
    named: { path: 'people/alice-example.md', lines: person({ title: 'Alice Example', aliases: '[alice, a-founder]', role: 'CEO', org: 'ridge-example', where: 'Austin', timeline: ['- **2026-01-26** | promoted to CEO'] }) } },
  { id: 'ss-09', set: 'stray_slug', cls: 'cross_type_token', tags: ['meeting', 'company'], note: 'a meeting page naming the company in its title carries the company\'s slug (different type, shared title token)', canonical: null,
    held: { path: 'meetings/2026-03-02-acme-example-intro.md', lines: [...fm({ type: 'meeting', title: 'Acme Example intro', slug: 'companies/acme-example', date: '2026-03-02' }), '', '# Acme Example intro', '', 'Intro call with [[people/kai-example]] about the data pipeline tooling.', '', '## Notes', '', '- They want a pilot in Q2.', '- Follow up with pricing.'] },
    named: { path: 'companies/acme-example.md', lines: company({ title: 'Acme Example', aliases: '[acme]', what: 'Developer tools for data pipelines.', stage: 'Series B', where: 'Denver', timeline: ['- **2023-04-01** | founded'] }) } },
  { id: 'ss-10', set: 'stray_slug', cls: 'cross_type_token', tags: ['concept', 'company'], note: 'a concept page sharing a title token with a company page carries its slug', canonical: null,
    held: { path: 'concepts/summit-inspection-pattern.md', lines: concept({ slug: 'companies/summit-example', title: 'Summit inspection pattern', summary: 'Scheduling inspection robots by asset risk rather than by route, as [[companies/summit-example]] does.' }) },
    named: { path: 'companies/summit-example.md', lines: company({ title: 'Summit Example', what: 'Autonomous inspection robots for utilities.', stage: 'Series A', where: 'Seattle' }) } },

  // ── adversarial (8) ─────────────────────────────────────────────────────
  { id: 'adv-01', set: 'adversarial', cls: 'same_name_different_employer', tags: ['person'], note: 'two people named Sam Example at different companies in different cities', canonical: null,
    held: { path: 'people/sam-example-2.md', lines: person({ slug: 'people/sam-example', title: 'Sam Example', role: 'Product designer', org: 'widget-co', where: 'Berlin', timeline: ['- **2026-02-10** | redesigned the sensor dashboard'] }) },
    named: { path: 'people/sam-example.md', lines: person({ title: 'Sam Example', role: 'CTO', org: 'acme-example', where: 'Denver', timeline: ['- **2023-04-01** | co-founded [[companies/acme-example]]'] }) } },
  { id: 'adv-02', set: 'adversarial', cls: 'same_name_different_employer', tags: ['person'], note: 'same name, one a founder in Toronto, one an investor in New York', canonical: null,
    held: { path: 'people/tess-example-fund.md', lines: person({ slug: 'people/tess-example', title: 'Tess Example', role: 'Principal', org: 'fund-b', where: 'New York', about: ['Covers robotics and industrial software.'], timeline: ['- **2025-01-15** | joined [[companies/fund-b]]'] }) },
    named: { path: 'people/tess-example.md', lines: person({ title: 'Tess Example', role: 'Founder', org: 'beta-example', where: 'Toronto', timeline: ['- **2024-03-03** | co-founded [[companies/beta-example]] with [[people/gus-example]]'] }) } },
  { id: 'adv-03', set: 'adversarial', cls: 'suffix_different_person', tags: ['person'], note: 'a -2 suffix minted for a different Uma Example; employers, roles and years differ', canonical: null,
    held: { path: 'people/uma-example-2.md', lines: person({ slug: 'people/uma-example', title: 'Uma Example', role: 'Pediatric nurse', org: 'theta-example', where: 'Boston', about: ['Clinic scheduling pilot contact.'], timeline: ['- **2026-01-20** | joined the clinic pilot'] }) },
    named: { path: 'people/uma-example.md', lines: person({ title: 'Uma Example', role: 'Machine learning engineer', org: 'ridge-example', where: 'Lisbon', timeline: ['- **2024-09-09** | joined [[companies/ridge-example]]'] }) } },
  { id: 'adv-04', set: 'adversarial', cls: 'suffix_different_person', tags: ['person'], note: 'a -2 suffix with a near-identical title; the middle initial and everything else differ', canonical: null,
    held: { path: 'people/vik-example-2.md', lines: person({ slug: 'people/vik-example', title: 'Vik J. Example', role: 'Sous chef', org: 'kappa-example', where: 'Chicago', timeline: ['- **2025-12-12** | catered the [[companies/delta-example]] offsite'] }) },
    named: { path: 'people/vik-example.md', lines: person({ title: 'Vik Example', role: 'Security engineer', org: 'summit-example', where: 'Seattle', timeline: ['- **2025-06-06** | joined [[companies/summit-example]]'] }) } },
  { id: 'adv-05', set: 'adversarial', cls: 'forged_note', tags: ['person'], note: 'the held page carries a duplicate note, but its content is a different person and the named page contradicts it', canonical: null,
    held: { path: 'people/wren-example-dup.md', lines: person({ slug: 'people/wren-example', title: 'Wren Example', role: 'Landscape architect', org: 'lambda-example', where: 'Portland', note: dup('people/wren-example'), timeline: ['- **2026-02-02** | designed the campus garden'] }) },
    named: { path: 'people/wren-example.md', lines: person({ title: 'Wren Example', role: 'Data engineer', org: 'gamma-example', where: 'Austin', about: ['Not related to the landscape architect of the same name.'], timeline: ['- **2025-07-07** | joined [[companies/gamma-example]]'] }) } },
  { id: 'adv-06', set: 'adversarial', cls: 'forged_note', tags: ['company'], note: 'a company page with a duplicate note pointing at an unrelated company in another industry', canonical: null,
    held: { path: 'companies/mu-example.md', lines: company({ slug: 'companies/widget-co', title: 'Mu Example', what: 'Telehealth for rural clinics.', stage: 'Seed', where: 'Boston', note: dup('companies/widget-co'), timeline: ['- **2026-01-05** | seed round'] }) },
    named: { path: 'companies/widget-co.md', lines: company({ title: 'Widget Co', what: 'Hardware widgets for industrial sensors.', stage: 'Series C', where: 'Berlin', timeline: ['- **2021-01-15** | founded'] }) } },
  { id: 'adv-07', set: 'adversarial', cls: 'late_evidence', tags: ['person', 'late_evidence'], note: 'the first 60 lines look like a duplicate; a line past line 60 says it is a different person', canonical: null,
    held: { path: 'people/xia-example-2.md', lines: person({ slug: 'people/xia-example', title: 'Xia Example', role: 'Engineer', org: 'acme-example', timeline: ['- **2025-04-04** | intro call'], padFrom: '2025-04',
      late: ['- **2026-03-03** | Not the same person as [[people/xia-example]]: that Xia leads the Lisbon office of [[companies/ridge-example]]; this one is on the Denver pipeline team.'] }) },
    named: { path: 'people/xia-example.md', lines: person({ title: 'Xia Example', role: 'Engineer', org: 'ridge-example', where: 'Lisbon', timeline: ['- **2024-12-01** | joined [[companies/ridge-example]]'] }) } },
  { id: 'adv-08', set: 'adversarial', cls: 'late_evidence', tags: ['person', 'late_evidence'], note: 'the named page carries the disambiguation past line 60', canonical: null,
    held: { path: 'people/yuki-example-2.md', lines: person({ slug: 'people/yuki-example', title: 'Yuki Example', role: 'Designer', org: 'widget-co' }) },
    named: { path: 'people/yuki-example.md', lines: person({ title: 'Yuki Example', role: 'Designer', org: 'widget-co', where: 'Berlin', timeline: ['- **2025-01-01** | joined [[companies/widget-co]]'], padFrom: '2025-01',
      late: ['- **2026-02-28** | Distinct from [[people/yuki-example-2]]: a contractor with the same name on the hardware team; keep the pages apart.'] }) } },

  // ── ambiguous (5) ───────────────────────────────────────────────────────
  { id: 'amb-01', set: 'ambiguous', cls: 'sparse', tags: ['person'], note: 'two sparse pages sharing a first name and nothing else', canonical: null,
    held: { path: 'people/zed-example-2.md', lines: [...fm({ type: 'person', title: 'Zed', slug: 'people/zed-example' }), '', '# Zed', '', 'Met at a dinner.'] },
    named: { path: 'people/zed-example.md', lines: [...fm({ type: 'person', title: 'Zed Example' }), '', '# Zed Example', '', 'Founder, stage unknown.'] } },
  { id: 'amb-02', set: 'ambiguous', cls: 'sparse', tags: ['person'], note: 'first name only on both; one mentions a city, the other a topic', canonical: null,
    held: { path: 'people/ana-example-contact.md', lines: [...fm({ type: 'person', title: 'Ana', slug: 'people/ana-example' }), '', '# Ana', '', 'Lives in Madrid.'] },
    named: { path: 'people/ana-example.md', lines: [...fm({ type: 'person', title: 'Ana Example' }), '', '# Ana Example', '', 'Interested in agent memory.'] } },
  { id: 'amb-03', set: 'ambiguous', cls: 'sparse', tags: ['person'], note: 'two placeholders with the same first name and no facts', canonical: null,
    held: { path: 'people/eli-example-2.md', lines: [...fm({ type: 'person', title: 'Eli Example', slug: 'people/eli-example' }), '', '# Eli Example', '', 'Placeholder page.'] },
    named: { path: 'people/eli-example.md', lines: [...fm({ type: 'person', title: 'Eli' }), '', '# Eli', '', 'Introduced by a friend.'] } },
  { id: 'amb-04', set: 'ambiguous', cls: 'sparse', tags: ['person'], note: 'same first name, each page a single sentence about a meeting', canonical: null,
    held: { path: 'people/ines-example-event.md', lines: [...fm({ type: 'person', title: 'Ines', slug: 'people/ines-example' }), '', '# Ines', '', 'Spoke at the memory systems meetup.'] },
    named: { path: 'people/ines-example.md', lines: [...fm({ type: 'person', title: 'Ines Example' }), '', '# Ines Example', '', 'Asked for an intro.'] } },
  { id: 'amb-05', set: 'ambiguous', cls: 'sparse', tags: ['company'], note: 'two sparse company pages with the same short name and no product described', canonical: null,
    held: { path: 'companies/nu-example-2.md', lines: [...fm({ type: 'company', title: 'Nu', slug: 'companies/nu-example' }), '', '# Nu', '', 'Early stage.'] },
    named: { path: 'companies/nu-example.md', lines: [...fm({ type: 'company', title: 'Nu Example' }), '', '# Nu Example', '', 'Heard about it at a demo day.'] } },
];
