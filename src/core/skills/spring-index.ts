/**
 * skills/spring-index.ts — the spring-loaded skill resolver's always-loaded
 * half: a compact index of gbrain's bundled skills, one line per skill with
 * its trigger phrases, plus the sentence that says how to load a skill on
 * demand: `<launcher> bundled-skill <name>`, which prints the skill from the
 * same gbrain that wrote the index (src/cli/commands/bundled-skill.ts).
 *
 * Generated from each skill's frontmatter `triggers:` (the canonical routing
 * signal; skills/RESOLVER.md is the human map of the same data), so there is
 * no second list to keep in sync. The header records the catalog identity
 * (bundledCatalogId) so doctor can tell an index an upgrade left behind.
 *
 * Budget: the block is loaded on every turn, so it is held under
 * SKILL_INDEX_BUDGET_BYTES. A line keeps up to three triggers; while the
 * block is over budget, the longest lines lose a trigger first, one line at a
 * time, down to one trigger each. A skill is never dropped: when even that
 * does not fit, rendering refuses (SkillIndexTooLarge) and the caller leaves
 * the instruction file as it was.
 */
import { shellQuote } from '../shell-quote.ts';
import { bundledCatalogId, bundledSkillTriggers, type BundledSkill } from './bundled.ts';

export const SKILL_INDEX_VERSION = 1;
/** Upper bound for the whole managed block interior. */
export const SKILL_INDEX_BUDGET_BYTES = 6144;
const MAX_TRIGGER_CHARS = 60;
const MAX_PER_SKILL = 3;

export class SkillIndexTooLarge extends Error {
  constructor(readonly bytes: number, readonly budget: number) {
    super(`the skills index needs ${bytes} bytes even with one trigger per skill, over its ${budget}-byte budget`);
  }
}

function cleanTrigger(t: string): string {
  const s = t.replace(/["`]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_TRIGGER_CHARS ? `${s.slice(0, MAX_TRIGGER_CHARS - 1).trimEnd()}…` : s;
}

/** Up to MAX_PER_SKILL triggers that each add a word the earlier ones did not. */
function distinctTriggers(skill: BundledSkill): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of bundledSkillTriggers(skill)) {
    const c = cleanTrigger(t);
    const words = c.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (words.length === 0 || words.every((w) => seen.has(w))) continue;
    for (const w of words) seen.add(w);
    out.push(c);
    if (out.length === MAX_PER_SKILL) break;
  }
  return out;
}

const line = (name: string, triggers: string[]) => (triggers.length ? `- ${name}: ${triggers.join('; ')}` : `- ${name}`);

export function skillIndexHeader(launcher: string, refresh: string, optOut: string): string[] {
  const run = shellQuote(launcher);
  return [
    `<!-- gbrain skills v${SKILL_INDEX_VERSION} catalog ${bundledCatalogId()}: managed by gbrain; edit outside these markers. Refresh: ${refresh}. Opt out: ${optOut} -->`,
    '## GBrain skills: load on demand',
    '',
    `GBrain ships step-by-step procedures for brain work. When a task matches a line below, run \`${run} bundled-skill <name>\` and follow the procedure it prints before acting. Print a file the skill names with \`${run} bundled-skill <name> --asset <path>\`. Load nothing for a task no line matches.`,
    '',
  ];
}

/** The block interior (without markers). Throws SkillIndexTooLarge rather than return a block over budget. */
export function renderSkillIndexBlock(skills: readonly BundledSkill[], launcher: string, opts: { refresh: string; optOut: string; budget?: number }): string {
  const budget = opts.budget ?? SKILL_INDEX_BUDGET_BYTES;
  const head = skillIndexHeader(launcher, opts.refresh, opts.optOut);
  const triggers = skills.map(distinctTriggers);
  const render = () => [...head, ...skills.map((s, i) => line(s.name, triggers[i]))].join('\n');
  let text = render();
  let bytes = Buffer.byteLength(text, 'utf8');
  while (bytes > budget) {
    let longest = -1;
    for (let i = 0; i < skills.length; i++) {
      if (triggers[i].length > 1 && (longest < 0 || line(skills[i].name, triggers[i]).length > line(skills[longest].name, triggers[longest]).length)) longest = i;
    }
    if (longest < 0) throw new SkillIndexTooLarge(bytes, budget);
    triggers[longest] = triggers[longest].slice(0, -1);
    text = render();
    bytes = Buffer.byteLength(text, 'utf8');
  }
  return text;
}

/** The catalog identity an index block records, or undefined for a block without one. */
export function skillIndexCatalog(interior: string): string | undefined {
  return /gbrain skills v\d+ catalog ([0-9a-f]+)/.exec(interior)?.[1];
}
