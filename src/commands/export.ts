import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { previewPersonalExport } from '../core/services/personal-export-visibility-service.ts';

export async function runExport(engine: BrainEngine, args: string[]) {
  const dirIdx = args.indexOf('--dir');
  const outDir = dirIdx !== -1 ? args[dirIdx + 1] : './export';

  if (args.includes('--personal-export')) {
    await runPersonalExport(engine, outDir, getFlagValue(args, '--query'));
    return;
  }

  await runPageExport(engine, outDir);
}

async function runPageExport(engine: BrainEngine, outDir: string) {
  const pages = await engine.listPages({ limit: 100000 });
  console.log(`Exporting ${pages.length} pages to ${outDir}/`);

  let exported = 0;

  for (const page of pages) {
    const tags = await engine.getTags(page.slug);
    const md = serializeMarkdown(
      page.frontmatter,
      page.compiled_truth,
      page.timeline,
      { type: page.type, title: page.title, tags },
    );

    const filePath = join(outDir, page.slug + '.md');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, md);

    // Export raw data as sidecar JSON
    const rawData = await engine.getRawData(page.slug);
    if (rawData.length > 0) {
      const slugParts = page.slug.split('/');
      const rawDir = join(outDir, ...slugParts.slice(0, -1), '.raw');
      mkdirSync(rawDir, { recursive: true });
      const rawPath = join(rawDir, slugParts[slugParts.length - 1] + '.json');

      const rawObj: Record<string, unknown> = {};
      for (const rd of rawData) {
        rawObj[rd.source] = rd.data;
      }
      writeFileSync(rawPath, JSON.stringify(rawObj, null, 2) + '\n');
    }

    exported++;
    if (exported % 100 === 0) {
      process.stdout.write(`\r  ${exported}/${pages.length} exported`);
    }
  }

  console.log(`\nExported ${exported} pages to ${outDir}/`);
}

async function runPersonalExport(engine: BrainEngine, outDir: string, query?: string) {
  const preview = await previewPersonalExport(engine, {
    requested_scope: 'personal',
    query,
  });

  if (preview.scope_gate.policy !== 'allow') {
    throw new Error(`Personal export blocked: ${preview.selection_reason}`);
  }

  console.log(`Exporting ${preview.profile_memory_entries.length} personal profile records to ${outDir}/`);

  const profileMemoryDir = join(outDir, 'personal', 'profile-memory');
  for (const entry of preview.profile_memory_entries) {
    const filePath = safeExportPath(profileMemoryDir, `${entry.id}.md`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, serializeProfileMemoryEntry(entry));
  }

  console.log(`Exported ${preview.profile_memory_entries.length} personal profile records to ${outDir}/`);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function safeExportPath(rootDir: string, fileName: string): string {
  const root = resolve(rootDir);
  const target = resolve(root, fileName);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Unsafe personal export path for id: ${fileName.replace(/\.md$/, '')}`);
  }
  return target;
}

function serializeProfileMemoryEntry(entry: Awaited<ReturnType<typeof previewPersonalExport>>['profile_memory_entries'][number]): string {
  const frontmatterLines = [
    '---',
    'type: profile_memory',
    `id: ${entry.id}`,
    `scope_id: ${entry.scope_id}`,
    `profile_type: ${entry.profile_type}`,
    `subject: ${entry.subject}`,
    `sensitivity: ${entry.sensitivity}`,
    `export_status: ${entry.export_status}`,
    'source_refs:',
    ...entry.source_refs.map((sourceRef) => `  - ${sourceRef}`),
    '---',
    '',
    `# ${entry.subject}`,
    '',
    entry.content,
    '',
  ];

  return `${frontmatterLines.join('\n')}\n`;
}
