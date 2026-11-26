/** The agent policy pages' fixed homes and page type (L1). Import-light: write admission reads it. */
export const POLICY_SCOPES = ['owner', 'company'] as const;
export type PolicyScope = (typeof POLICY_SCOPES)[number];
export const POLICY_SLUGS: Record<PolicyScope, string> = { owner: 'policy/agent', company: 'company/policy/agent' };
export const POLICY_SOURCE = 'default';
export const AGENT_POLICY_TYPE = 'agent_policy';

export function isPolicySlug(slug: unknown): boolean {
  return typeof slug === 'string' && (Object.values(POLICY_SLUGS) as string[]).includes(slug.replace(/\.md$/, '').toLowerCase());
}
