import { describe, expect, test } from 'bun:test';
import {
  audiencesAllowed,
  audiencePatternMatches,
  canReadPage,
  canWritePage,
  normalizePageAudiences,
  parseAudiencesFromMarkdown,
  type MemoryGroupPolicy,
} from '../src/core/memory-policy.ts';

const codingGroup: MemoryGroupPolicy = {
  id: 'mg_coding',
  name: 'Coding',
  readAudiences: ['coding', 'project:*', 'public'],
  writeAudiences: ['coding', 'project:*', 'public'],
  readSlugPrefixes: [],
  writeSlugPrefixes: [],
  deniedAudiences: [],
  bypassPolicy: false,
};

const managementGroup: MemoryGroupPolicy = {
  id: 'mg_management',
  name: 'Management',
  readAudiences: ['*'],
  writeAudiences: ['personal', 'work', 'coding', 'public', 'project:*'],
  readSlugPrefixes: [],
  writeSlugPrefixes: [],
  deniedAudiences: [],
  bypassPolicy: false,
};

describe('memory-policy', () => {
  test('normalizePageAudiences defaults to public', () => {
    expect(normalizePageAudiences({})).toEqual(['public']);
    expect(normalizePageAudiences(undefined)).toEqual(['public']);
  });

  test('audiencePatternMatches glob project:*', () => {
    expect(audiencePatternMatches('project:*', 'project:gbrain')).toBe(true);
    expect(audiencePatternMatches('project:*', 'coding')).toBe(false);
  });

  test('coding cannot read personal audience', () => {
    expect(canReadPage(codingGroup, ['personal'], 'decision-pay')).toBe(false);
    expect(canReadPage(managementGroup, ['personal'], 'decision-pay')).toBe(true);
  });

  test('coding can read project pages', () => {
    expect(canReadPage(codingGroup, ['coding', 'project:gbrain'], 'project-gbrain-arch')).toBe(true);
  });

  test('unassigned group denies read', () => {
    expect(canReadPage(null, ['public'], 'any')).toBe(false);
  });

  test('bypass policy allows all', () => {
    const admin: MemoryGroupPolicy = { ...codingGroup, bypassPolicy: true };
    expect(canReadPage(admin, ['personal'], 'secret')).toBe(true);
    expect(canWritePage(admin, ['personal'], 'secret')).toBe(true);
  });

  test('parseAudiencesFromMarkdown', () => {
    const md = `---
title: Test
audience: [personal, work]
---
body`;
    expect(parseAudiencesFromMarkdown(md)).toEqual(['personal', 'work']);
  });

  test('audiencesAllowed with star', () => {
    expect(audiencesAllowed(['*'], ['personal'])).toBe(true);
  });
});
