/**
 * Unit coverage for the `gbrain serve --http` skill-publishing banner + nudge
 * (`skillPublishStatus`). When skill publishing is OFF, a connected coding
 * agent (Codex / Claude Code / Perplexity) can't call list_skills / get_skill,
 * so the host's skill catalog is invisible to it. The operator should learn
 * this at serve startup, not from an empty list on the agent side — which is
 * the exact friction this nudge closes for the "add my coding agent to my
 * existing brain" funnel.
 */
import { describe, test, expect } from 'bun:test';
import { skillPublishStatus } from '../src/commands/serve-http.ts';

describe('skillPublishStatus', () => {
  test('publishing ON: banner says published, no nudge', () => {
    const s = skillPublishStatus(true);
    expect(s.bannerValue).toBe('published');
    expect(s.nudge).toBeNull();
  });

  test('publishing OFF: banner says not published', () => {
    const s = skillPublishStatus(false);
    expect(s.bannerValue).toBe('not published');
    expect(s.nudge).not.toBeNull();
  });

  test('OFF nudge carries the paste-ready fix command', () => {
    const s = skillPublishStatus(false);
    expect(s.nudge).toContain('gbrain config set mcp.publish_skills true');
  });

  test('OFF nudge names the affected tools so the operator understands the blast radius', () => {
    const s = skillPublishStatus(false);
    expect(s.nudge).toContain('list_skills');
    expect(s.nudge).toContain('get_skill');
  });

  test('OFF nudge reassures that core tools still work (so operators do not over-react)', () => {
    const s = skillPublishStatus(false);
    expect(s.nudge!.toLowerCase()).toContain('core tools');
  });

  test('banner value fits the fixed-width startup box (≤ 40 chars after padEnd)', () => {
    // The banner pads each value with .padEnd(40); a longer raw value would
    // blow out the ASCII box. Guard the contract here.
    expect(skillPublishStatus(true).bannerValue.length).toBeLessThanOrEqual(40);
    expect(skillPublishStatus(false).bannerValue.length).toBeLessThanOrEqual(40);
  });
});
