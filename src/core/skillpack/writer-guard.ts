import { OperationError } from '../ops/contract.ts';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { assertLegacyFilesystemWriter, assertManagedFilesystemWrite } from '../persistence/filesystem-guard.ts';
import type { SqlEngine } from '../persistence/model.ts';

function refuse(error: unknown): never {
  if (error instanceof OperationError && error.code === 'writer_coordinator_required') {
    throw new OperationError('skill_bundle_required', 'Legacy skill writers cannot change a managed canonical worktree.',
      'Use put_skill with the catalog expected_revision and complete approved file bundle; an existing pack requires host-authorized adoptSharedSkillpack adoption. Run legacy optimization in an unmanaged working copy, then submit the reviewed result through put_skill.');
  }
  throw error;
}

export function assertLegacySkillFilesystemWrite(path: string): void {
  try { assertManagedFilesystemWrite(path); } catch (error) { refuse(error); }
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) return assertLegacySkillFilesystemWrite(resolve(dirname(path), readlinkSync(path)));
  if (stat.isFile() && stat.nlink > 1) throw new OperationError('skill_bundle_required',
    'Legacy skill writers cannot safely replace a multiply linked file.',
    'Use a detached unmanaged working copy, then publish the reviewed complete bundle through put_skill; adopt an existing canonical pack with host-authorized adoptSharedSkillpack.');
}

function resolveExistingAncestor(path: string): string {
  let current = path;
  const missing: string[] = [];
  for (;;) {
    try { lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current)); current = parent;
      continue;
    }
    return resolve(realpathSync(current), ...missing.reverse());
  }
}

export function confinedSkillChildWrite(root: string, child: string, opts: { dryRun?: boolean } = {}): string {
  const invalid = () => new OperationError('target_escape', 'The skill target must remain within its selected root.');
  if (typeof root !== 'string' || !root || root.includes('\0') || typeof child !== 'string' || !child ||
    /[\x00-\x1f\x7f]/.test(child) || isAbsolute(child) || win32.isAbsolute(child) || /^[a-z]:/i.test(child) ||
    sep !== '\\' && child.includes('\\')) throw invalid();
  const segments = child.split(/[\\/]/);
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw invalid();
  const logicalRoot = resolve(root);
  const target = resolve(logicalRoot, ...segments);
  const inside = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  };
  if (!inside(logicalRoot, target)) throw invalid();
  try {
    if (!inside(resolveExistingAncestor(logicalRoot), resolveExistingAncestor(target))) throw invalid();
  } catch { throw invalid(); }
  if (!opts.dryRun) assertLegacySkillFilesystemWrite(target);
  return target;
}

export async function assertLegacySkillWriter(engine: SqlEngine, path: string): Promise<void> {
  try { await assertLegacyFilesystemWriter(engine, path); } catch (error) { refuse(error); }
  assertLegacySkillFilesystemWrite(path);
}
