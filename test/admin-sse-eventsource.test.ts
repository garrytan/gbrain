import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

describe('admin dashboard SSE credentials', () => {
  const dashboardSrc = readFileSync('admin/src/pages/Dashboard.tsx', 'utf8');

  test('Live Activity EventSource sends admin session cookies through reverse proxies', () => {
    expect(dashboardSrc).toMatch(
      /new EventSource\(\s*['"]\/admin\/events['"]\s*,\s*\{\s*withCredentials:\s*true\s*\}\s*\)/,
    );
    expect(dashboardSrc).not.toMatch(/new EventSource\(\s*['"]\/admin\/events['"]\s*\)/);
  });
});
