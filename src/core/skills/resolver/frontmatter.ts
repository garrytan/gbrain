/**
 * Bounded SKILL.md reader for the resolver: name, description,
 * when_to_use, triggers, `disable-model-invocation` and `eligible`, plus
 * the first 4 KB of the body. Reads at most 64 KB of a file. Leaf module
 * (alias-bounded js-yaml via data-frontmatter.ts and the one-line description rule only).
 *
 * The body rule matches the Step 1 catalog builder: drop the frontmatter
 * fence, trim, keep the first 4,096 UTF-8 bytes without a split character.
 */
import { CORE_SCHEMA } from 'js-yaml';
import { loadBoundedYaml } from '../../data-frontmatter.ts';
import { oneLineDescription } from '../../skill-description.ts';

export const SKILL_FILE_CAP_BYTES = 64 * 1024;
export const BODY_CAP_BYTES = 4096;

export interface SkillDoc {
  name?: string;
  description: string;
  whenToUse?: string;
  triggers: string[];
  modelInvocable: boolean;
  eligible: boolean;
  body: string;
}

export const cleanText = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

export function boundBody(text: string): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const buf = Buffer.from(body, 'utf8');
  if (buf.length <= BODY_CAP_BYTES) return body;
  return buf.subarray(0, BODY_CAP_BYTES).toString('utf8').replace(/\uFFFD+$/, '');
}

function yamlFields(raw: string): Record<string, unknown> | null {
  try {
    const v = loadBoundedYaml(raw, { schema: CORE_SCHEMA, json: true });
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringList(v: unknown): string[] {
  if (typeof v === 'string') return [cleanText(v)].filter(Boolean);
  if (!Array.isArray(v)) return [];
  return v.filter(x => typeof x === 'string' || typeof x === 'number').map(cleanText).filter(Boolean);
}

/** Parse one SKILL.md text (already bounded to SKILL_FILE_CAP_BYTES). */
export function parseSkillDoc(input: string): SkillDoc {
  const text = input.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const raw = m ? m[1] : '';
  const fm = m ? yamlFields(raw) : null;
  const bodyText = m ? text.slice(m[0].length) : text;
  const yamlDescription = fm && typeof fm.description === 'string' ? cleanText(fm.description) : '';
  const description = yamlDescription || cleanText(oneLineDescription(raw, bodyText.replace(/^\n/, '')));
  const whenToUse = fm ? cleanText(fm.when_to_use ?? fm['when-to-use'] ?? '') : '';
  return {
    name: fm && (typeof fm.name === 'string' || typeof fm.name === 'number') ? cleanText(fm.name) || undefined : undefined,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    triggers: fm ? stringList(fm.triggers) : [],
    modelInvocable: !(fm && (fm['disable-model-invocation'] === true || fm['disable-model-invocation'] === 'true')),
    eligible: !(fm && (fm.eligible === false || fm.eligible === 'false')),
    body: boundBody(text),
  };
}
