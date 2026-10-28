/** The managed spring-loaded skill index block: setup/skills-block.ts writes it; check-resolvable.ts and doctor's skill_currency read past it. */
export const SKILLS_BLOCK_BEGIN = '<!-- gbrain:skills:begin -->';
export const SKILLS_BLOCK_END = '<!-- gbrain:skills:end -->';

/** Names of the skills a file's managed index lists (its `- <name>: …` lines); empty when the file has no index. */
export function skillsIndexedIn(text: string): string[] {
  const begin = text.indexOf(SKILLS_BLOCK_BEGIN);
  const end = text.indexOf(SKILLS_BLOCK_END, begin);
  if (begin < 0 || end < 0) return [];
  return text.slice(begin, end).split('\n').flatMap(l => /^- ([a-z][a-z0-9-]*)(?::|$)/.exec(l)?.[1] ?? []);
}
