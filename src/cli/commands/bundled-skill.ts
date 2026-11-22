/**
 * `gbrain bundled-skill [<name>] [--asset <path>] [--json]`: print one of
 * gbrain's bundled skills (or one file it names) from the binary itself.
 * The on-demand half of the spring-loaded skill resolver: the skills index
 * that `gbrain setup <harness> --skill-loading spring` writes names this
 * command, so the index and the text it loads always come from the same
 * gbrain. Engine-free: it opens no brain, needs no MCP server or skill
 * publication, and works on a thin client and from a compiled binary.
 *
 * Audience: on a thin-client install (not the brain host) the host-only
 * skills (db-repair, migrations, …) are not offered, matching the index the
 * thin-client install writes.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStdoutFinal } from '../../core/cli-force-exit.ts';
import { loadConfig, isThinClient } from '../../core/config.ts';
import { opError } from '../../core/ops/contract.ts';
import { findGbrainRoot } from '../../core/skillpack/bundle.ts';
import { suggestNearest } from '../../core/levenshtein.ts';
import { bundledCatalogId, bundledSkillAsset, bundledSkillDescription, bundledSkills, bundledSkillText, findBundledSkill, type SkillAudience } from '../../core/skills/bundled.ts';
import { VERSION } from '../../version.ts';
import { movedSkillNotice } from '../../core/skillpack/moved.ts';
import { exitCliError, usageError } from '../cli-error.ts';
import { applyMovedRegistryTestSeam } from '../moved-registry-seam.ts';

const HELP = `Usage: gbrain bundled-skill [<name>] [--asset <path>] [--json]

Print a skill gbrain ships (the procedure an agent follows for a task), read
from this gbrain itself. No brain connection is needed.

  gbrain bundled-skill                      every bundled skill, one line each
  gbrain bundled-skill <name>               the skill's SKILL.md, then the files it names
  gbrain bundled-skill <name> --asset <p>   one file the skill names (as listed)
  --json                                    machine-readable output; with no
                                            name it also gives skills_root, the
                                            skills folder this gbrain was
                                            installed with (null for a
                                            single-file binary)

The skills index written by \`gbrain setup <harness> --skill-loading spring\`
tells agents to run this command when a task matches a skill. A skill that
moved to another catalog says where it went.
`;

export function bundledSkillAudience(): SkillAudience {
  return isThinClient(loadConfig()) ? 'downstream' : 'owner';
}

/**
 * The skills folder of the gbrain that is running, found from this module and
 * the entrypoint (never the cwd, which may be another checkout), or null when
 * the skills exist only inside a compiled binary.
 */
export function installedSkillsRoot(): string | null {
  const starts: string[] = [];
  try { starts.push(dirname(fileURLToPath(import.meta.url))); } catch { /* compiled binary */ }
  if (process.argv[1]) starts.push(dirname(resolve(process.argv[1])));
  for (const start of starts) {
    const root = findGbrainRoot(start);
    if (root && existsSync(join(root, 'skills', 'RESOLVER.md'))) return join(root, 'skills');
  }
  return null;
}

export async function run(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    await writeStdoutFinal(HELP);
    return;
  }
  applyMovedRegistryTestSeam();
  const json = args.includes('--json');
  let asset: string | undefined;
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') continue;
    if (a === '--asset' || a.startsWith('--asset=')) {
      const v = a === '--asset' ? args[++i] : a.slice('--asset='.length);
      if (asset !== undefined) exitCliError(usageError('--asset was given twice.', 'Pass one file per call.'), 'bundled-skill');
      if (v === undefined || v === '' || v.startsWith('--')) exitCliError(usageError('--asset requires a file path the skill lists.', 'Run the same command without --asset to see the files the skill names.'), 'bundled-skill');
      asset = v;
    } else if (a.startsWith('-')) {
      exitCliError(usageError(`unknown flag ${a} for gbrain bundled-skill.`, 'Usage: gbrain bundled-skill [<name>] [--asset <path>] [--json]', { code: 'unknown_flag' }), 'bundled-skill');
    } else {
      names.push(a);
    }
  }
  if (names.length > 1) exitCliError(usageError(`gbrain bundled-skill takes one skill name, got ${names.length}.`, 'Usage: gbrain bundled-skill [<name>] [--asset <path>] [--json]'), 'bundled-skill');
  const name = names[0];
  const audience = bundledSkillAudience();

  if (name === undefined) {
    if (asset !== undefined) exitCliError(usageError('--asset needs a skill name.', 'Usage: gbrain bundled-skill <name> --asset <path>'), 'bundled-skill');
    const skills = await Promise.all(bundledSkills(audience).map(async s => ({ name: s.name, description: await bundledSkillDescription(s) })));
    await writeStdoutFinal(json
      ? `${JSON.stringify({ schema_version: 1, gbrain_version: VERSION, catalog: bundledCatalogId(), skills_root: installedSkillsRoot(), skills }, null, 2)}\n`
      : `${skills.map(s => `${s.name.padEnd(28)} ${s.description}`).join('\n')}\n`);
    return;
  }

  const skill = findBundledSkill(name, audience);
  const moved = movedSkillNotice(name);
  if (!skill && moved) {
    await writeStdoutFinal(json ? `${JSON.stringify({ schema_version: 1, gbrain_version: VERSION, name, moved }, null, 2)}\n` : `${moved}\n`);
    return;
  }
  if (moved) process.stderr.write(`${moved}\n`);
  if (!skill) {
    const nearest = suggestNearest(name, bundledSkills(audience).map(s => s.name));
    exitCliError(opError('skill_not_found', `gbrain ${VERSION} has no bundled skill named ${name}${audience === 'downstream' ? ' for this thin-client install' : ''}.${nearest ? ` Did you mean "${nearest}"?` : ''}`,
      `Run the same command with no name to list them. A skills index from another gbrain version may name a renamed skill; refresh it with ${audience === 'downstream' ? 'the gbrain connect … --install command in the index header (it rewrites GBRAIN-INSTRUCTIONS.md)' : '`gbrain setup <harness> --skills-index-only`'}.`), 'bundled-skill');
  }

  if (asset !== undefined) {
    const content = bundledSkillAsset(skill, asset);
    if (content === undefined) {
      exitCliError(opError('skill_not_found', `${name} names no file ${asset}.`,
        skill.assets.length ? `Pass one of its files exactly: ${skill.assets.join(', ')}.` : `${name} names no files; its SKILL.md is the whole procedure.`), 'bundled-skill');
    }
    await writeStdoutFinal(json ? `${JSON.stringify({ schema_version: 1, gbrain_version: VERSION, name, asset, content }, null, 2)}\n` : content.endsWith('\n') ? content : `${content}\n`);
    return;
  }

  const content = bundledSkillText(skill);
  if (json) {
    await writeStdoutFinal(`${JSON.stringify({ schema_version: 1, gbrain_version: VERSION, catalog: bundledCatalogId(), name, description: await bundledSkillDescription(skill), assets: skill.assets, content }, null, 2)}\n`);
    return;
  }
  const files = skill.assets.length
    ? `\n---\nFiles this skill names (print one by re-running this command with --asset <path>):\n${skill.assets.map(a => `- ${a}`).join('\n')}\n`
    : '';
  await writeStdoutFinal(`${content.endsWith('\n') ? content : `${content}\n`}${files}`);
}
