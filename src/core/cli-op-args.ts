import type { ParamDef } from './ops/contract.ts';

/** Parse and assign one operation CLI value, accumulating array flags. */
export function assignOpArgValue(
  params: Record<string, unknown>,
  key: string,
  def: ParamDef | undefined,
  raw: string,
): void {
  if (def?.type === 'array' && def.items?.type === 'string') {
    const values = raw.split(',').map(value => value.trim()).filter(Boolean);
    const prior = Array.isArray(params[key]) ? params[key] as unknown[] : [];
    params[key] = [...prior, ...values];
    return;
  }
  params[key] = def?.type === 'boolean' ? raw !== 'false'
    : def?.type === 'number' ? Number(raw)
    : raw;
}
