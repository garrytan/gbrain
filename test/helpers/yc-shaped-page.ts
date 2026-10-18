/**
 * #6712 PR 3 (L6): a deterministic company page shaped like a large production
 * page (a YC-style company profile): prose sections, a facts fence, a long
 * timeline and code-path references. At scale 1 it is about 337 KB with 1,012
 * facts, 4,100 timeline rows and 50 code references; every count scales
 * linearly with `scale`. Names are generic placeholders.
 */
export interface YcShapedPage { text: string; facts: number; timeline: number; codeRefs: string[] }

export const YC_SHAPED_BASE = { facts: 1012, timeline: 4100, codeRefs: 50 } as const;

export const ycCodePath = (i: number) => `src/widgets/module-${String(i).padStart(3, '0')}.ts`;

const REPEAT = 16;

export function ycShapedPage(scale = 1, version = 'v1'): YcShapedPage {
  const facts = Math.round(YC_SHAPED_BASE.facts * scale);
  const timeline = Math.round(YC_SHAPED_BASE.timeline * scale);
  const refs = Math.round(YC_SHAPED_BASE.codeRefs * scale);
  const day = (n: number) => new Date(Date.UTC(2012, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
  const codeRefs = Array.from({ length: refs }, (_, i) => ycCodePath(i));
  const sections = Math.max(1, Math.round(24 * scale));
  const paragraphs = Array.from({ length: sections }, (_, i) =>
    `## Section ${i} (${version})\n\nAcme Example ${'operating detail about widget-co customers, revenue lines and hiring plans. '.repeat(REPEAT)}`);
  const refLines = codeRefs.map((path, i) => `- Implementation note ${i}: see ${path}:${20 + i} for the widget pipeline.`);
  const rows = Array.from({ length: facts }, (_, i) =>
    `| ${i + 1} | Claim ${i + 1} about acme-example ${version} | fact | 0.9 | world | medium | ${day(i)} |  | fixture |  |`);
  const bullets = Array.from({ length: timeline }, (_, i) => `- **${day(i)}** | Event ${i + 1} at acme-example ${version}`);
  const text = [
    '---', 'type: company', 'title: Acme Example', '---', '', '# Acme Example', '', ...paragraphs.flatMap(p => [p, '']),
    '## Code', '', ...refLines, '',
    '## Facts', '', '<!--- gbrain:facts:begin -->',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
    '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
    ...rows, '<!--- gbrain:facts:end -->', '', '<!-- timeline -->', '', ...bullets, '',
  ].join('\n');
  return { text, facts, timeline, codeRefs };
}
