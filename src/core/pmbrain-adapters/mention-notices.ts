export interface Notice {
  code: string;
  kind: 'safety' | 'degraded' | 'coaching' | 'ask' | 'info';
  why: string;
  fix?: {
    argv: string[];
    consent: string[];
    actor: string;
    requires_exclusive: boolean;
    why: string;
    verify?: { argv: string[] };
  };
}
export function agentBlock(fields: Partial<Record<'ask' | 'why' | 'risk' | 'consent' | 'actor' | 'next' | 'if_yes' | 'if_no' | 'verify', string>>): string {
  return ['[AGENT]', ...Object.entries(fields).filter(([, value]) => value).map(([key, value]) => `${key}: ${value!.replace(/[\r\n]+/g, ' ').replace(/\[(?:\/?AGENT|\/?SHOW USER)\]/g, '')}`), '[/AGENT]', ''].join('\n');
}
