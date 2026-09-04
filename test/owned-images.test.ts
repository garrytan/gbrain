/**
 * Native page-image contract: official files-backend persistence, source/page
 * isolation, native MCP pixels, and a narrowly bounded legacy read fallback.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations } from '../src/core/operations.ts';
import type { AuthInfo } from '../src/core/operations.ts';
import { hasScope } from '../src/core/scope.ts';
import { STARTER_OPS } from '../src/mcp/surface.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { DispatchOpts } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const PAGE = 'produit/espace-client/references-visuelles';
const PAGE_PATH = `${PAGE}.md`;
const LEGACY_REF = '../../media/legacy.png';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2xQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');
const PNG_2_BYTES = Buffer.from(PNG_BYTES);
PNG_2_BYTES[PNG_2_BYTES.length - 1] = PNG_2_BYTES[PNG_2_BYTES.length - 1]! ^ 1;

let engine: PGLiteEngine;
let root: string;
let sourceRoot: string;
let otherRoot: string;
let storageRoot: string;
let configHome: string;
let noStorageHome: string;

const AUTH: AuthInfo = {
  token: 'redacted-test-token',
  clientId: 'katezo-agent',
  scopes: ['read', 'write'],
  sourceId: 'katezo',
  allowedSources: ['katezo'],
};
const DISPATCH: DispatchOpts = {
  remote: true,
  transport: 'stdio' as const,
  sourceId: 'katezo',
  auth: AUTH,
};

function textJson(result: Awaited<ReturnType<typeof dispatchToolCall>>): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected metadata text block first');
  return JSON.parse(first.text) as Record<string, unknown>;
}

function call(
  name: string,
  args: Record<string, unknown>,
  opts = DISPATCH,
  home = configHome,
) {
  return withEnv({ GBRAIN_HOME: home }, () => dispatchToolCall(engine, name, args, opts));
}

async function seedSource(id: string, localPath: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ($1, $1, $2, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [id, localPath],
  );
}

async function seedPage(
  sourceId: string,
  localPath: string,
  slug = PAGE,
  body = `# Références visuelles\n\n![Legacy](${LEGACY_REF})\n`,
  visibility: 'world' | 'private' = 'world',
): Promise<void> {
  const sourcePath = `${slug}.md`;
  const content = `---\ntitle: Références visuelles\ntype: note\nvisibility: ${visibility}\n---\n\n${body}`;
  await importFromContent(engine, slug, content, { noEmbed: true, sourceId, sourcePath });
  const pageFile = join(localPath, sourcePath);
  mkdirSync(dirname(pageFile), { recursive: true });
  writeFileSync(pageFile, content);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  root = mkdtempSync(join(tmpdir(), 'gbrain-owned-images-'));
  sourceRoot = join(root, 'katezo');
  otherRoot = join(root, 'other');
  storageRoot = join(root, 'storage');
  configHome = join(root, 'home');
  noStorageHome = join(root, 'home-no-storage');
  for (const dir of [sourceRoot, otherRoot, storageRoot, join(configHome, '.gbrain'), join(noStorageHome, '.gbrain')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(configHome, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    storage: { backend: 'local', bucket: 'test', localPath: storageRoot },
  }));
  writeFileSync(join(noStorageHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
  await seedSource('katezo', sourceRoot);
  await seedSource('other', otherRoot);
  await seedPage('katezo', sourceRoot);
  await seedPage('other', otherRoot);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('put_image through the official files backend', () => {
  test('stores immutable bytes + a files row and retries idempotently without writing into the source repo', async () => {
    const args = {
      page_slug: PAGE,
      filename: 'desktop.png',
      content_base64: PNG_BASE64,
      mime_type: 'image/png',
      alt_text: 'Fiche de traitement',
    };
    const first = await call('put_image', args);
    expect(first.isError).toBeUndefined();
    expect(first.content).toHaveLength(1);
    const meta = textJson(first);
    expect(meta.status).toBe('created');
    expect(meta.storage_path).toMatch(/^images\/katezo\/produit\/espace-client\/references-visuelles\/[a-f0-9]{64}\/desktop\.png$/);
    expect(meta.image_ref).toBe(meta.storage_path);
    expect(meta.alt_text).toBe('Fiche de traitement');
    expect(meta.mime_type).toBe('image/png');
    expect(meta.size_bytes).toBe(PNG_BYTES.length);
    expect((first.content[0] as { text: string }).text).not.toContain(PNG_BASE64);

    const storagePath = meta.storage_path as string;
    expect(existsSync(join(storageRoot, storagePath))).toBe(true);
    expect(existsSync(join(sourceRoot, 'media'))).toBe(false);
    const row = await engine.getFile('katezo', storagePath);
    expect(row).toEqual(expect.objectContaining({
      source_id: 'katezo', page_slug: PAGE, filename: 'desktop.png', mime_type: 'image/png',
    }));
    expect(row?.page_id).toBe((await engine.getPage(PAGE, { sourceId: 'katezo' }))?.id);
    expect(row?.metadata).toEqual(expect.objectContaining({ storage: 'backend', kind: 'page_image' }));

    const second = await call('put_image', args);
    expect(textJson(second).status).toBe('unchanged');
    expect(textJson(second).storage_path).toBe(storagePath);
  });

  test('updates by creating a new content-addressed object without deleting the previous version', async () => {
    const base = { page_slug: PAGE, filename: 'diagram.png', mime_type: 'image/png' };
    const first = await call('put_image', { ...base, content_base64: PNG_BASE64 });
    const firstPath = textJson(first).storage_path as string;
    const second = await call('put_image', { ...base, content_base64: PNG_2_BYTES.toString('base64') });
    const secondMeta = textJson(second);
    const secondPath = secondMeta.storage_path as string;
    expect(secondMeta.status).toBe('updated');
    expect(secondPath).not.toBe(firstPath);
    expect(existsSync(join(storageRoot, firstPath))).toBe(true);
    expect(existsSync(join(storageRoot, secondPath))).toBe(true);
    const page = await engine.getPage(PAGE, { sourceId: 'katezo' });
    expect(await engine.listFilesForPage(page!.id)).toHaveLength(2);
  });

  test('fails closed without a configured storage backend and never inserts a phantom row', async () => {
    const result = await call('put_image', {
      page_slug: PAGE, filename: 'no-store.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    }, DISPATCH, noStorageHome);
    expect(textJson(result).error).toBe('storage_error');
    expect(await engine.executeRaw(`SELECT id FROM files WHERE filename = 'no-store.png'`)).toHaveLength(0);
  });

  test('validates bytes, MIME, page ownership, source grants, and slug fences before mutation', async () => {
    const malformed = await call('put_image', {
      page_slug: PAGE, filename: 'x.png', content_base64: '%%%=', mime_type: 'image/png',
    });
    expect(textJson(malformed).error).toBe('invalid_params');

    const mismatch = await call('put_image', {
      page_slug: PAGE, filename: 'x.jpg', content_base64: PNG_BASE64, mime_type: 'image/jpeg',
    });
    expect(textJson(mismatch).error).toBe('invalid_params');

    const missing = await call('put_image', {
      page_slug: 'produit/inexistant', filename: 'x.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    expect(textJson(missing).error).toBe('page_not_found');

    const crossSource = await call('put_image', {
      source_id: 'other', page_slug: PAGE, filename: 'x.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    expect(textJson(crossSource).error).toBe('permission_denied');

    const fenced = await call('put_image', {
      page_slug: PAGE, filename: 'x.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    }, { ...DISPATCH, auth: { ...AUTH, boundSlugPrefixes: ['wiki/agents/alice/'] } });
    expect(textJson(fenced).error).toBe('permission_denied');

    const operation = operations.find(candidate => candidate.name === 'put_image');
    expect(operation?.scope).toBe('write');
    expect(hasScope(['read'], operation?.scope ?? 'read')).toBe(false);
    expect(STARTER_OPS.has('put_image')).toBe(false);
    expect(STARTER_OPS.has('get_image')).toBe(false);
  });

  test('dry_run reports the immutable target without touching storage or files metadata', async () => {
    const result = await call('put_image', {
      page_slug: PAGE,
      filename: 'dry.png',
      content_base64: PNG_BASE64,
      mime_type: 'image/png',
      dry_run: true,
    }, DISPATCH, noStorageHome);
    expect(textJson(result).status).toBe('dry_run');
    expect(await engine.executeRaw(`SELECT id FROM files WHERE filename = 'dry.png'`)).toHaveLength(0);
    expect(existsSync(join(storageRoot, 'images'))).toBe(false);
  });
});

describe('get_image native MCP response', () => {
  test('downloads an owned files row and returns metadata first plus native pixels', async () => {
    const put = await call('put_image', {
      page_slug: PAGE, filename: 'native.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const imageRef = textJson(put).image_ref as string;
    const result = await call('get_image', { page_slug: PAGE, image_ref: imageRef });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[1] as unknown).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
    const meta = textJson(result);
    expect(meta.storage).toBe('backend');
    expect(meta.storage_path).toBe(imageRef);
    expect((result.content[0] as { text: string }).text).not.toContain(PNG_BASE64);
  });

  test('refuses a file row owned by another page, a private page, missing bytes, and hash drift', async () => {
    await seedPage('katezo', sourceRoot, 'produit/autre-page', '# Autre page\n');
    const otherPut = await call('put_image', {
      page_slug: 'produit/autre-page', filename: 'other.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const otherRef = textJson(otherPut).image_ref as string;
    const crossPage = await call('get_image', { page_slug: PAGE, image_ref: otherRef });
    expect(textJson(crossPage).error).toBe('not_found');

    await seedPage('katezo', sourceRoot, 'produit/private', '# Private\n', 'private');
    const privatePut = await call('put_image', {
      page_slug: 'produit/private', filename: 'private.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const privateRead = await call('get_image', {
      page_slug: 'produit/private', image_ref: textJson(privatePut).image_ref,
    });
    expect(textJson(privateRead).error).toBe('page_not_found');

    const put = await call('put_image', {
      page_slug: PAGE, filename: 'integrity.png', content_base64: PNG_BASE64, mime_type: 'image/png',
    });
    const ref = textJson(put).image_ref as string;
    unlinkSync(join(storageRoot, ref));
    const missing = await call('get_image', { page_slug: PAGE, image_ref: ref });
    expect(textJson(missing).error).toBe('not_found');

    writeFileSync(join(storageRoot, ref), PNG_2_BYTES);
    const drift = await call('get_image', { page_slug: PAGE, image_ref: ref });
    expect(textJson(drift).error).toBe('storage_error');
  });

  test('reads an official git-backed files row without requiring the binary backend', async () => {
    const page = await engine.getPage(PAGE, { sourceId: 'katezo' });
    const gitPath = 'assets/git-image.png';
    mkdirSync(join(sourceRoot, 'assets'), { recursive: true });
    writeFileSync(join(sourceRoot, gitPath), PNG_BYTES);
    await engine.upsertFile({
      source_id: 'katezo', page_id: page!.id, page_slug: PAGE,
      filename: 'git-image.png', storage_path: gitPath, mime_type: 'image/png',
      size_bytes: PNG_BYTES.length,
      content_hash: createHash('sha256').update(PNG_BYTES).digest('hex'),
      metadata: { storage: 'git' },
    });
    const result = await call('get_image', { page_slug: PAGE, image_ref: gitPath }, DISPATCH, noStorageHome);
    expect(result.content[1] as unknown).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
    expect(textJson(result).storage).toBe('git');
  });
});

describe('legacy repository fallback', () => {
  test('serves only an exact Markdown image reference carried by the authorized page', async () => {
    const legacyPath = join(sourceRoot, 'media', 'legacy.png');
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, PNG_BYTES);
    const result = await call('get_image', { page_slug: PAGE, image_ref: LEGACY_REF }, DISPATCH, noStorageHome);
    expect(result.isError).toBeUndefined();
    expect(result.content[1] as unknown).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
    expect(textJson(result).storage).toBe('legacy_git');

    writeFileSync(join(sourceRoot, 'media', 'secret.png'), PNG_BYTES);
    const unreferenced = await call('get_image', {
      page_slug: PAGE, image_ref: '../../media/secret.png',
    }, DISPATCH, noStorageHome);
    expect(textJson(unreferenced).error).toBe('not_found');
  });

  test('rejects a page-referenced symlink escape and wrong-source reads', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.png'), PNG_BYTES);
    symlinkSync(outside, join(sourceRoot, 'escape'));
    await seedPage('katezo', sourceRoot, PAGE, '# References\n\n![Escape](../../escape/secret.png)\n');
    const escaped = await call('get_image', {
      page_slug: PAGE, image_ref: '../../escape/secret.png',
    }, DISPATCH, noStorageHome);
    expect(textJson(escaped).error).toBe('permission_denied');

    const wrongSource = await call('get_image', {
      source_id: 'other', page_slug: PAGE, image_ref: LEGACY_REF,
    }, DISPATCH, noStorageHome);
    expect(textJson(wrongSource).error).toBe('permission_denied');
  });
});
