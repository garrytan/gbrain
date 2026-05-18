/**
 * Tests for src/core/filing-audit.ts — Check 6 (W3, v0.17).
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  loadFilingRules,
  allowedDirectories,
  runFilingAudit,
} from '../src/core/filing-audit.ts';

const created: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'filing-audit-'));
  created.push(dir);
  return dir;
}

function writeRules(skillsDir: string, body?: object): void {
  const doc = body ?? {
    version: '1.0.0',
    rules: [
      { kind: 'person', directory: 'people/' },
      { kind: 'company', directory: 'companies/' },
    ],
    sources_dir: { directory: 'sources/', purpose: 'raw data only' },
  };
  writeFileSync(join(skillsDir, '_brain-filing-rules.json'), JSON.stringify(doc, null, 2));
}

function writeSkill(
  skillsDir: string,
  name: string,
  opts: {
    writes_pages?: boolean;
    writes_to?: string[];
    writes_to_inline?: boolean;
    mutating?: boolean;
    no_frontmatter?: boolean;
  } = {},
): void {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  if (opts.no_frontmatter) {
    writeFileSync(join(dir, 'SKILL.md'), `# ${name}\nNo frontmatter.\n`);
    return;
  }
  const lines = ['---', `name: ${name}`];
  if (opts.mutating !== undefined) lines.push(`mutating: ${opts.mutating}`);
  if (opts.writes_pages !== undefined) lines.push(`writes_pages: ${opts.writes_pages}`);
  if (opts.writes_to) {
    if (opts.writes_to_inline) {
      lines.push(`writes_to: [${opts.writes_to.map(s => `"${s}"`).join(', ')}]`);
    } else {
      lines.push('writes_to:');
      for (const d of opts.writes_to) lines.push(`  - ${d}`);
    }
  }
  lines.push('---');
  lines.push(`# ${name}\n`);
  writeFileSync(join(dir, 'SKILL.md'), lines.join('\n'));
}

afterEach(() => {
  while (created.length) {
    const d = created.pop();
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe('loadFilingRules', () => {
  it('returns null when rules file is missing', () => {
    const dir = scratch();
    expect(loadFilingRules(dir)).toBeNull();
  });
  it('parses a valid rules document', () => {
    const dir = scratch();
    writeRules(dir);
    const rules = loadFilingRules(dir);
    expect(rules).not.toBeNull();
    expect(rules!.rules.length).toBe(2);
    expect(rules!.rules[0].kind).toBe('person');
  });
  it('throws on malformed JSON', () => {
    const dir = scratch();
    writeFileSync(join(dir, '_brain-filing-rules.json'), '{ not valid');
    expect(() => loadFilingRules(dir)).toThrow();
  });
  it('throws when rules is not an array', () => {
    const dir = scratch();
    writeFileSync(
      join(dir, '_brain-filing-rules.json'),
      JSON.stringify({ version: '1', rules: 'oops' }),
    );
    expect(() => loadFilingRules(dir)).toThrow();
  });
});

describe('allowedDirectories', () => {
  it('normalizes directory strings (trailing slash)', () => {
    const allowed = allowedDirectories({
      version: '1',
      rules: [
        { kind: 'a', directory: 'people/' },
        { kind: 'b', directory: 'companies' }, // no slash
      ],
      sources_dir: { directory: '/sources', purpose: 'raw' },
    });
    expect(allowed.has('people/')).toBe(true);
    expect(allowed.has('companies/')).toBe(true);
    expect(allowed.has('sources/')).toBe(true);
  });
});

describe('runFilingAudit', () => {
  it('returns empty report when rules file is missing (no-op)', () => {
    const dir = scratch();
    // No _brain-filing-rules.json.
    writeSkill(dir, 'enrich', { writes_pages: true, writes_to: ['people/'] });
    const r = runFilingAudit(dir);
    expect(r.issues).toEqual([]);
    expect(r.totalScanned).toBe(0);
  });

  it('clean: declares writes_pages + valid writes_to', () => {
    const dir = scratch();
    writeRules(dir);
    writeSkill(dir, 'enrich', {
      writes_pages: true,
      writes_to: ['people/', 'companies/'],
    });
    const r = runFilingAudit(dir);
    expect(r.issues).toEqual([]);
    expect(r.writesPagesSkills).toBe(1);
  });

  it('flags missing writes_to when writes_pages is true', () => {
    const dir = scratch();
    writeRules(dir);
    writeSkill(dir, 'enrich', { writes_pages: true });
    const r = runFilingAudit(dir);
    expect(r.issues.length).toBe(1);
    expect(r.issues[0].type).toBe('filing_missing_writes_to');
    expect(r.issues[0].severity).toBe('warning');
  });

  it('flags unknown directory in writes_to', () => {
    const dir = scratch();
    writeRules(dir);
    writeSkill(dir, 'enrich', {
      writes_pages: true,
      writes_to: ['people/', 'junk/'],
    });
    const r = runFilingAudit(dir);
    expect(r.issues.length).toBe(1);
    expect(r.issues[0].type).toBe('filing_unknown_directory');
    expect(r.issues[0].directory).toBe('junk/');
  });

  it('D-CX-7: mutating:true alone does NOT trigger filing audit', () => {
    // Cron/scheduler/report skills use mutating:true but don't write
    // brain pages. Filing-audit must skip them entirely.
    const dir = scratch();
    writeRules(dir);
    writeSkill(dir, 'cron-scheduler', { mutating: true });
    const r = runFilingAudit(dir);
    expect(r.issues).toEqual([]);
    expect(r.writesPagesSkills).toBe(0);
  });

  it('skips skills with writes_pages: false', () => {
    const dir = scratch();
    writeRules(dir);
    writeSkill(dir, 'query', { writes_pages: false });
    const r = runFilingAudit(dir);
    expect(r.issues).toEqual([]);
  });

  it('skips skills with no frontmatter', () => {
    const dir = scratch();
    writeRules(dir);
    writeSkill(dir, 'bare', { no_frontmatter: true });
    const r = runFilingAudit(dir);
    expect(r.issues).toEqual([]);
  });

  it('parses inline writes_to: [a, b] syntax', () => {
    const dir = scratch();
    writeRules(dir);
    writeSkill(dir, 'enrich', {
      writes_pages: true,
      writes_to: ['people/', 'companies/'],
      writes_to_inline: true,
    });
    const r = runFilingAudit(dir);
    expect(r.issues).toEqual([]);
  });

  it('allows sources/ (raw data dir)', () => {
    const dir = scratch();
    writeRules(dir);
    writeSkill(dir, 'importer', {
      writes_pages: true,
      writes_to: ['sources/'],
    });
    const r = runFilingAudit(dir);
    expect(r.issues).toEqual([]);
  });

  it('skips underscore and dot dirs', () => {
    const dir = scratch();
    writeRules(dir);
    writeSkill(dir, '_conventions', {
      writes_pages: true,
      writes_to: ['not-real/'],
    });
    const r = runFilingAudit(dir);
    expect(r.issues).toEqual([]);
  });

  it('totalScanned counts every skill with SKILL.md', () => {
    const dir = scratch();
    writeRules(dir);
    writeSkill(dir, 'a');
    writeSkill(dir, 'b', { writes_pages: true, writes_to: ['people/'] });
    writeSkill(dir, 'c', { writes_pages: false });
    const r = runFilingAudit(dir);
    expect(r.totalScanned).toBe(3);
    expect(r.writesPagesSkills).toBe(1);
  });

  it('handles missing skillsDir cleanly', () => {
    const r = runFilingAudit('/tmp/never-exists-filing-audit-ABC');
    expect(r.issues).toEqual([]);
    expect(r.totalScanned).toBe(0);
  });

  it('action string names the exact file to edit (test coverage guard)', () => {
    const dir = scratch();
    writeRules(dir);
    writeSkill(dir, 'enrich', { writes_pages: true, writes_to: ['bad/'] });
    const r = runFilingAudit(dir);
    expect(r.issues[0].action).toContain('SKILL.md');
    expect(r.issues[0].action.length).toBeGreaterThan(10);
  });
});
