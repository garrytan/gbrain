/**
 * Fix wave 5 error catalogue (DX-O1 / DX-O2 / ENG-O12): every catalogue
 * entry's docs anchor exists in its guide, and a catalogue refusal carries its
 * code, one-sentence message, hint and docs pointer on both wire shapes
 * (`OperationError.toJSON()` for CLI `--json` and MCP; the StructuredError
 * envelope for CLI-only surfaces).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_CATALOGUE, catalogueError, catalogueStructuredError, type CatalogueName } from '../src/core/error-catalogue.ts';
import { serializeError } from '../src/core/errors.ts';

const ROOT = join(import.meta.dir, '..');

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
function headingAnchor(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

function anchorsOf(path: string): Set<string> {
  const text = readFileSync(join(ROOT, path), 'utf8').replace(/^```[\s\S]*?^```/gm, '');
  const anchors = new Set<string>();
  for (const [, heading] of text.matchAll(/^#{1,6}\s+(.+)$/gm)) anchors.add(headingAnchor(heading!));
  for (const [, id] of text.matchAll(/<a id="([^"]+)"><\/a>/g)) anchors.add(id!);
  return anchors;
}

describe('error catalogue docs anchors', () => {
  test('every entry points at docs/guides/repair.md or write-refusals.md and its anchor exists', () => {
    const names = Object.keys(ERROR_CATALOGUE) as CatalogueName[];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const [path, anchor] = ERROR_CATALOGUE[name].docs.split('#');
      expect(['docs/guides/repair.md', 'docs/guides/write-refusals.md']).toContain(path!);
      expect(anchor, `${name} has no anchor`).toBeTruthy();
      expect(anchorsOf(path!).has(anchor!), `${name}: ${path}#${anchor} does not exist`).toBe(true);
    }
  });

  test('the anchor resolver rejects a heading that does not exist', () => {
    expect(anchorsOf('docs/guides/repair.md').has('preview-changed')).toBe(true);
    expect(anchorsOf('docs/guides/repair.md').has('no-such-wave-5-heading')).toBe(false);
  });

  test('the DX-O2 codes are catalogued with their stable codes, and the legacy refusal keeps permission_denied', () => {
    for (const code of ['legacy_jobs_active', 'legacy_job_selection_invalid', 'preview_changed', 'projection_owner_resident',
      'colon_slug_windows_write_through', 'embedding_auth_failed'] as const) {
      expect(ERROR_CATALOGUE[code].code).toBe(code);
    }
    expect(ERROR_CATALOGUE.legacy_job_authority).toEqual({ code: 'permission_denied', docs: 'docs/guides/repair.md#legacy-job-authority' });
    expect(ERROR_CATALOGUE.colon_slug_windows_write_through.docs).toStartWith('docs/guides/write-refusals.md#');
  });
});

describe('catalogue refusals on the wire', () => {
  test('OperationError.toJSON carries code, message, hint as suggestion and the anchor as docs', () => {
    const error = catalogueError('projection_owner_resident', 'A resident owner holds this PGLite brain.', 'Stop it first: gbrain serve --stop');
    expect(error.toJSON()).toMatchObject({ error: 'projection_owner_resident', message: 'A resident owner holds this PGLite brain.',
      suggestion: 'Stop it first: gbrain serve --stop', docs: 'docs/guides/repair.md#projection-owner-resident' });
    expect(JSON.parse(JSON.stringify(catalogueError('legacy_job_authority', 'm.', 'h')))).toMatchObject({ error: 'permission_denied', docs: 'docs/guides/repair.md#legacy-job-authority' });
  });

  test('the StructuredError envelope names them hint and docs_url', () => {
    const error = catalogueStructuredError('legacy_job_selection_invalid', 'SelectionInvalid', 'Unknown --select key "state".', 'gbrain jobs authorize-legacy --select "status=waiting"');
    expect(serializeError(error)).toEqual({ class: 'SelectionInvalid', code: 'legacy_job_selection_invalid', message: 'Unknown --select key "state".',
      hint: 'gbrain jobs authorize-legacy --select "status=waiting"', docs_url: 'docs/guides/repair.md#legacy-job-selection-invalid' });
  });
});
