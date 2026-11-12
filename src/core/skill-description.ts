/**
 * One-line skill descriptions, as the skill catalog shows them: the
 * frontmatter `description:` (inline or a `|` / `>` block scalar folded to
 * one line), else the body's first prose line. Leaf module, shared by
 * `list_skills` (src/core/skill-catalog.ts), the bundled-skill reader
 * (src/core/skills/bundled.ts) and the skill resolver, so none of them has
 * to load the operations table to describe a skill.
 */

/**
 * `description: |` (literal) and `description: >` (folded), with optional
 * chomping/indent indicators (`|-`, `>+`, `|2`), are parsed by reading the
 * following indented lines and folding them into a single line.
 */
function parseDescriptionField(raw: string): string | undefined {
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^description:[ \t]*(.*)$/);
    if (!m) continue;
    const inline = m[1].trim();

    if (/^[|>][+-]?\d*$/.test(inline)) {
      const block: string[] = [];
      let baseIndent: number | null = null;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim().length === 0) { block.push(''); continue; }
        const indent = line.length - line.trimStart().length;
        if (baseIndent === null) {
          if (indent === 0) break;
          baseIndent = indent;
        }
        if (indent < baseIndent) break;
        block.push(line.slice(baseIndent));
      }
      const folded = block.join(' ').replace(/\s+/g, ' ').trim();
      return folded.length > 0 ? folded : undefined;
    }

    const unq = inline.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    return unq.length > 0 ? unq : undefined;
  }
  return undefined;
}

/** First non-empty, non-heading prose line of the body (description fallback). */
function firstProseLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    if (t.startsWith('#')) continue;
    if (t.startsWith('<!--')) continue;
    return t.replace(/^[*_>`-]+\s*/, '').trim();
  }
  return '';
}

/** description = frontmatter `description:` or first prose line, else ''. */
export function oneLineDescription(raw: string, body: string): string {
  return parseDescriptionField(raw) ?? firstProseLine(body);
}
