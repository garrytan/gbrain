/**
 * GBRA-218 (A2) folder rules across export and import (plan §15 "Backups and
 * moves", §16 "Import barrier").
 *
 * Export writes each source's applied rulebook (never a held widening): a
 * one-source export as .gbrain/access.yml plus .gbrain/access.approved, the
 * files a git-backed source keeps; an export of several sources as
 * .gbrain/access/<source>.yml, including sources with no exported page. A
 * source whose committed policy file is invalid has prefixes reading as
 * nobody that no rulebook can express, so its export refuses instead of
 * carrying a wider rulebook.
 *
 * Import installs the chosen rulebook before it publishes any page, through
 * proposeRevision: narrowing applies at once (with durable pending coverage
 * until restamped), widening is held for gbrain access apply. Source-qualified
 * files are mapped explicitly with --access-policy <exported-source> (a lone
 * one is taken as is); with several and no choice, the import refuses before
 * writing anything.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { parsePolicyYaml, serializePolicyYaml, type FolderRule } from './folder-rules.ts';
import { appliedRules, coverageRows, proposeRevision, readAccessStore, type ProposalResult } from './policy.ts';
import { APPROVED_FILE, POLICY_FILE, isGitWorkTree, sourcePolicyRoot } from './policy-git.ts';

const EXPORT_HEADER = 'Folder rules exported by gbrain export (the applied rulebook).';
export const SOURCE_POLICY_DIR = '.gbrain/access';

/** The policy files an export carries for one source, or for every source with folder rules when sourceId is null. */
export async function exportPolicyFiles(engine: BrainEngine, sourceId: string | null): Promise<Array<{ path: string; content: string }>> {
  const sources = sourceId ? [sourceId]
    : (await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM access_policy_state ORDER BY source_id')).map(r => r.source_id);
  const files: Array<{ path: string; content: string }> = [];
  for (const source of sources) {
    const invalid = (await coverageRows(engine, source)).filter(c => c.reason === 'invalid');
    if (invalid.length) {
      throw opError('access_policy_invalid', `Source ${source}'s committed folder-rule file does not validate, so ${invalid.map(c => c.prefix || 'the whole source').join(', ')} read as nobody and no exported rulebook can carry that; nothing was exported.`,
        `See the problems with gbrain access rule list --source ${source}, fix .gbrain/access.yml, commit it and sync, then export again; other sources export one at a time with gbrain export --source.`);
    }
    const rules = await appliedRules(engine, source);
    if (!rules.length) continue;
    const text = serializePolicyYaml(rules, EXPORT_HEADER);
    if (sourceId) files.push({ path: POLICY_FILE, content: text }, { path: APPROVED_FILE, content: text });
    else files.push({ path: `${SOURCE_POLICY_DIR}/${source}.yml`, content: text });
  }
  return files;
}

/** The rulebook an import tree carries for its destination, or null when it carries none (or the caller chose none). */
export function importPolicyChoice(dir: string, choice: string | undefined): { file: string; rules: FolderRule[] } | null {
  const single = join(dir, POLICY_FILE);
  const qualifiedDir = join(dir, SOURCE_POLICY_DIR);
  const qualified = existsSync(qualifiedDir) ? readdirSync(qualifiedDir).filter(f => f.endsWith('.yml')).map(f => f.slice(0, -4)).sort() : [];
  if (choice === 'none') return null;
  let file: string;
  if (choice !== undefined) {
    if (!qualified.includes(choice)) {
      throw opError('access_policy_invalid', `The import tree has no folder-rule file for source "${choice}" (${qualified.length ? `it has ${qualified.join(', ')}` : 'it has no source-qualified rule file'}); nothing was imported.`,
        `Pass --access-policy with one of the listed sources, or --access-policy none to import without folder rules.`);
    }
    file = join(qualifiedDir, choice + '.yml');
  } else if (existsSync(single)) {
    file = single;
  } else if (qualified.length === 1) {
    file = join(qualifiedDir, qualified[0] + '.yml');
  } else if (qualified.length) {
    throw opError('access_policy_invalid', `The import tree carries folder rules for several sources (${qualified.join(', ')}) and none was chosen for the destination; nothing was imported.`,
      `Run the import again with --access-policy ${qualified[0]} (or another of ${qualified.join(', ')}) naming the exported source whose rules this destination takes, or --access-policy none to import without folder rules.`);
  } else return null;
  const parsed = parsePolicyYaml(readFileSync(file, 'utf8'));
  if (!parsed.ok) {
    throw opError('access_policy_invalid', `${file} does not validate: ${parsed.problems.map(p => `${p.line ? `line ${p.line}: ` : ''}${p.message}`).join('; ')}; nothing was imported.`,
      'Fix the file and run the import again.');
  }
  return { file, rules: parsed.rules };
}

/** gbrain import's barrier: reads --access-policy from the import argv, installs the rulebook and reports it; a refusal is printed before it is rethrown. */
export async function importPolicyBarrier(engine: BrainEngine, sourceId: string, dir: string, args: readonly string[], log: (line: string) => void): Promise<void> {
  const flag = args.indexOf('--access-policy');
  try {
    const policy = await installImportedPolicy(engine, sourceId, dir, flag === -1 ? undefined : args[flag + 1]);
    if (!policy) return;
    log(`Folder rules from ${policy.file}: revision ${policy.revision} ${policy.state}${policy.held.length ? ` (widening held: preview with gbrain access apply --source ${sourceId})` : ''}`);
  } catch (error) {
    const e = error as Error & { suggestion?: string };
    console.error(`${e.message}${e.suggestion ? ` ${e.suggestion}` : ''}`);
    throw error;
  }
}

/** The import barrier: installs the tree's rulebook for the destination before any page is published. */
export async function installImportedPolicy(engine: BrainEngine, sourceId: string, dir: string, choice: string | undefined): Promise<(ProposalResult & { file: string }) | null> {
  const picked = importPolicyChoice(dir, choice);
  if (!picked) return null;
  let store = await readAccessStore(engine, sourceId);
  if (!store) {
    const root = await sourcePolicyRoot(engine, sourceId);
    store = root && isGitWorkTree(root) ? 'git' : 'database';
  }
  const result = await proposeRevision(engine, sourceId, picked.rules, { origin: 'import', store });
  return { ...result, file: picked.file };
}
