import { OperatorError } from './errors.ts';

export type ParsedArgs = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const [commandRaw, ...rest] = argv;
  const command = commandRaw || 'help';
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token) continue;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    if (!key) throw new OperatorError('invalid_args', 'Empty flag name.');
    const next = rest[i + 1];
    const value = !next || next.startsWith('--') ? true : next;
    if (value !== true) i += 1;

    if (flags[key] === undefined) flags[key] = value;
    else if (Array.isArray(flags[key])) (flags[key] as string[]).push(String(value));
    else flags[key] = [String(flags[key]), String(value)];
  }

  return { command, positionals, flags };
}

export function str(flags: ParsedArgs['flags'], key: string, fallback?: string): string | undefined {
  const value = flags[key];
  if (value === undefined) return fallback;
  if (Array.isArray(value)) return value.at(-1);
  if (value === true) return 'true';
  return value;
}

export function arr(flags: ParsedArgs['flags'], key: string): string[] {
  const value = flags[key];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  if (value === true) return [];
  return [value];
}

export function bool(flags: ParsedArgs['flags'], key: string, fallback = false): boolean {
  const value = str(flags, key);
  if (value === undefined) return fallback;
  return value === '1' || value === 'true' || value === 'yes';
}

export function num(flags: ParsedArgs['flags'], key: string, fallback: number): number {
  const value = str(flags, key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new OperatorError('invalid_number', `--${key} must be numeric.`);
  return parsed;
}
