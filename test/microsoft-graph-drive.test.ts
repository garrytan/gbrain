import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from '../src/core/markdown.ts';
import {
  buildGraphDriveMarkdown,
  buildInitialDeltaUrl,
  chooseSharePointDrive,
  driveItemRelativePath,
  isTextLikeDriveItem,
  sitePathFromUrl,
  slugForDriveItem,
  syncGraphDriveSource,
  type GraphDriveItem,
} from '../src/core/microsoft-graph-drive.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageInput } from '../src/core/types.ts';

function makeFakeEngine() {
  const source: { name: string; config: Record<string, unknown> } = {
    name: 'SharePoint Docs',
    config: {
      connector: 'microsoft-graph-drive',
      provider: 'sharepoint',
      drive_id: 'drive-1',
      drive_name: 'Documents',
      site_id: 'site-1',
      site_name: 'Team Site',
      federated: true,
    },
  };
  const pages = new Map<string, { slug: string; source_id: string; source_path: string | null; frontmatter: Record<string, unknown>; compiled_truth: string }>();
  const engine = {
    kind: 'pglite',
    async executeRaw(sql: string, params: unknown[] = []) {
      if (sql.includes('SELECT name, config FROM sources')) {
        return [source];
      }
      if (sql.includes("frontmatter->>'graph_item_id'")) {
        const sourceId = params[0];
        const itemId = params[1];
        return Array.from(pages.values())
          .filter(p => p.source_id === sourceId && p.frontmatter.graph_item_id === itemId)
          .map(p => ({ slug: p.slug, source_path: p.source_path }))
          .slice(0, 1);
      }
      if (sql.includes('UPDATE sources')) {
        source.config = params[1] as typeof source.config;
        return [];
      }
      throw new Error(`unexpected SQL in fake engine: ${sql}`);
    },
    async getPage(slug: string, opts?: { sourceId?: string }) {
      const page = pages.get(`${opts?.sourceId ?? 'default'}:${slug}`);
      if (!page) return null;
      return {
        id: 1,
        slug,
        type: 'note',
        title: slug,
        compiled_truth: page.compiled_truth,
        timeline: '',
        frontmatter: page.frontmatter,
        created_at: new Date(),
        updated_at: new Date(),
        source_id: page.source_id,
      };
    },
    async transaction<T>(fn: (tx: BrainEngine) => Promise<T>) {
      return fn(engine as unknown as BrainEngine);
    },
    async createVersion() {},
    async putPage(slug: string, page: PageInput, opts?: { sourceId?: string }) {
      const sourceId = opts?.sourceId ?? 'default';
      pages.set(`${sourceId}:${slug}`, {
        slug,
        source_id: sourceId,
        source_path: page.source_path ?? null,
        frontmatter: page.frontmatter ?? {},
        compiled_truth: page.compiled_truth,
      });
      return (await engine.getPage(slug, { sourceId }))!;
    },
    async getTags() { return []; },
    async addTag() {},
    async removeTag() {},
    async upsertChunks() {},
    async deleteChunks() {},
    async addLink() { throw new Error('no target'); },
    async deletePage(slug: string, opts?: { sourceId?: string }) {
      pages.delete(`${opts?.sourceId ?? 'default'}:${slug}`);
    },
  };
  return { engine: engine as unknown as BrainEngine, source, pages };
}

describe('microsoft graph drive connector helpers', () => {
  test('derives a relative path from Graph parentReference.path', () => {
    const item: GraphDriveItem = {
      id: 'item-1',
      name: 'Plan.md',
      parentReference: { path: '/drives/drive-1/root:/General/Projects' },
      file: { mimeType: 'text/markdown' },
    };
    expect(driveItemRelativePath(item)).toBe('General/Projects/Plan.md');
  });

  test('reuses existing directory when delta omits parent path', () => {
    const item: GraphDriveItem = {
      id: 'item-1',
      name: 'Renamed.md',
      parentReference: { id: 'parent-1' },
      file: { mimeType: 'text/markdown' },
    };
    expect(driveItemRelativePath(item, 'General/Projects/Old.md')).toBe('General/Projects/Renamed.md');
  });

  test('keeps slugs readable while adding an item-id hash for collision safety', () => {
    const slug = slugForDriveItem('General Projects/Quarterly Plan.md', 'drive-item-123');
    expect(slug).toMatch(/^general-projects\/quarterly-plan-[a-f0-9]{8}$/);
    expect(slugForDriveItem('🚀.md', 'drive-item-123')).toMatch(/^microsoft-graph\/[a-f0-9]{8}$/);
  });

  test('classifies text-like files by extension or mime type', () => {
    expect(isTextLikeDriveItem({ id: '1', name: 'notes.md', file: {} })).toBe(true);
    expect(isTextLikeDriveItem({ id: '2', name: 'export.bin', file: { mimeType: 'text/plain' } })).toBe(true);
    expect(isTextLikeDriveItem({ id: '3', name: 'deck.pptx', file: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } })).toBe(false);
  });

  test('builds parseable markdown with Graph metadata in frontmatter', () => {
    const md = buildGraphDriveMarkdown(
      {
        id: 'abc123',
        name: 'Notes.txt',
        webUrl: 'https://contoso.sharepoint.com/sites/team/Shared%20Documents/Notes.txt',
        size: 42,
        file: { mimeType: 'text/plain' },
        parentReference: { id: 'parent' },
        lastModifiedDateTime: '2026-05-26T12:00:00Z',
        lastModifiedBy: { user: { displayName: 'Test User' } },
      },
      'Shared Documents/Notes.txt',
      {
        provider: 'sharepoint',
        driveId: 'drive-1',
        driveName: 'Documents',
        siteId: 'site-1',
        siteName: 'Team Site',
        contentText: 'hello from graph',
      },
    );
    const parsed = parseMarkdown(md, 'notes.md');
    expect(parsed.title).toBe('Notes.txt');
    expect(parsed.type).toBe('note');
    expect(parsed.tags).toContain('microsoft-graph');
    expect(parsed.frontmatter.graph_item_id).toBe('abc123');
    expect(parsed.compiled_truth).toContain('hello from graph');
  });

  test('builds initial delta URL with select fields and top', () => {
    const url = buildInitialDeltaUrl('drive!id', 25);
    expect(url).toStartWith('/drives/drive!id/root/delta?');
    expect(decodeURIComponent(url)).toContain('$select=');
    expect(decodeURIComponent(url)).toContain('@microsoft.graph.downloadUrl');
    expect(decodeURIComponent(url)).toContain('$top=25');
  });

  test('chooses SharePoint document library by id, name, singleton, or Documents default', () => {
    const drives = [
      { id: 'a', name: 'Assets', driveType: 'documentLibrary' },
      { id: 'b', name: 'Documents', driveType: 'documentLibrary' },
    ];
    expect(chooseSharePointDrive(drives, { driveId: 'a' }).id).toBe('a');
    expect(chooseSharePointDrive(drives, { driveName: 'documents' }).id).toBe('b');
    expect(chooseSharePointDrive(drives).id).toBe('b');
    expect(chooseSharePointDrive([{ id: 'only', name: 'Library' }]).id).toBe('only');
  });

  test('parses SharePoint site URLs for Graph site lookup', () => {
    expect(sitePathFromUrl('https://contoso.sharepoint.com/sites/Team%20Site/')).toEqual({
      hostname: 'contoso.sharepoint.com',
      relativePath: '/sites/Team Site',
    });
  });

  test('sync imports a text item and saves the returned delta cursor', async () => {
    const fake = makeFakeEngine();
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/root/delta')) {
        return new Response(JSON.stringify({
          value: [
            {
              id: 'item-1',
              name: 'Notes.txt',
              webUrl: 'https://contoso/Notes.txt',
              size: 11,
              file: { mimeType: 'text/plain' },
              parentReference: { path: '/drives/drive-1/root:/General' },
            },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta(token=abc)',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/content')) {
        return new Response('hello graph', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const result = await syncGraphDriveSource(fake.engine, {
      sourceId: 'spdocs',
      token: 'token',
      noEmbed: true,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result.imported).toBe(1);
    expect(result.delta_complete).toBe(true);
    expect(fake.source.config.delta_link).toContain('token=abc');
    const stored = Array.from(fake.pages.values())[0];
    expect(stored.source_path).toBe('General/Notes.txt');
    expect(stored.frontmatter.graph_item_id).toBe('item-1');
    expect(stored.compiled_truth).toContain('hello graph');
  });
});
