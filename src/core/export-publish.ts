import { lstatSync, opendirSync } from 'node:fs';
import { join, parse, relative, resolve, sep } from 'node:path';
import { nativeExportPublisher } from './persistence/native-lock.ts';
import { exportPathKey, type ExportStage } from './export-stage.ts';

function hasDirectory(path: string): boolean {
  const root = parse(path).root;
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Export destination has an unsafe directory. Use an operator-controlled destination without symlinks or reparse points.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

export async function publishExport(stage: ExportStage, destination: string, tick: (path: string) => void | Promise<void> = () => {}): Promise<void> {
  const publisher = await nativeExportPublisher();
  const root = resolve(destination);
  for (const row of stage.db.query<{ path: string }, []>("SELECT '' AS path UNION ALL SELECT path FROM paths WHERE kind='directory'").iterate()) {
    const directory = join(root, ...row.path.split('/'));
    if (!hasDirectory(directory)) continue;
    const entries = opendirSync(directory);
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        const path = row.path ? row.path + '/' + entry.name : entry.name;
        let key: string;
        try { key = exportPathKey(path); } catch { continue; }
        const planned = stage.db.query<{ path: string; kind: string }, [string]>('SELECT path, kind FROM paths WHERE key=?').get(key);
        if (!planned) continue;
        const info = lstatSync(join(directory, entry.name));
        if (planned.path !== path || planned.kind !== 'directory' || !info.isDirectory() || info.isSymbolicLink()) {
          throw new Error('Export destination has an occupied, aliased or unsafe planned path. Nothing was published. Use a fresh destination.');
        }
      }
    } finally { entries.closeSync(); }
  }
  const handle = publisher.beginExport(root);
  try {
    for (const row of stage.db.query<{ path: string; payload: string }, []>("SELECT path, payload FROM paths WHERE kind='file' ORDER BY path").iterate()) {
      publisher.publishExportFile(handle, row.path, Buffer.from(row.payload));
      await tick(row.path);
    }
    publisher.completeExport(handle);
  } finally { publisher.closeExport(handle); }
}
