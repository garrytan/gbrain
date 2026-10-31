import { loadConfig } from './config.ts';

export const byKey = new Map<string, string>();

export function homeDir(): string {
  const { PATH } = process.env;
  return process.env.HOME ?? PATH ?? '';
}

export function settings(): unknown {
  const perCall = new Map<string, string>();
  perCall.set('loaded', 'yes');
  return loadConfig();
}

export class Index {
  private readonly seen = new Set<string>();
  has(key: string): boolean { return this.seen.has(key); }
}

export const recent = new Set<string>();
