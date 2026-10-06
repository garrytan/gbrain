import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';

/**
 * Size bounds for the shared-skills migration inventory (`inventorySkillpack`).
 * Database config, written only through the trusted local `gbrain config set`
 * (no MCP operation writes config). Each value is capped by
 * INVENTORY_LIMIT_CEILINGS; confinement checks (symlinks, hard links, unsafe
 * paths, directory depth) are not configurable.
 */
export interface InventoryLimits {
  max_files: number;
  max_total_bytes: number;
  max_file_bytes: number;
  max_entries: number;
}

export const DEFAULT_INVENTORY_LIMITS: Readonly<InventoryLimits> = {
  max_files: 256, max_total_bytes: 4 * 1024 * 1024, max_file_bytes: 262_144, max_entries: 1024,
};

export const INVENTORY_LIMIT_CEILINGS: Readonly<InventoryLimits> = {
  max_files: 4096, max_total_bytes: 64 * 1024 * 1024, max_file_bytes: 8 * 1024 * 1024, max_entries: 16_384,
};

const PREFIX = 'shared_skills.inventory.';
export const inventoryLimitKey = (name: keyof InventoryLimits): string => `${PREFIX}${name}`;
export const INVENTORY_LIMIT_KEYS: readonly string[] = (Object.keys(DEFAULT_INVENTORY_LIMITS) as Array<keyof InventoryLimits>).map(inventoryLimitKey);

export function parseInventoryLimitValue(key: string, value: string): number {
  const name = key.slice(PREFIX.length) as keyof InventoryLimits;
  const ceiling = INVENTORY_LIMIT_CEILINGS[name];
  if (!/^[1-9]\d*$/.test(value) || Number(value) > ceiling) {
    throw opError('invalid_params', `Invalid ${key}: expected a whole number from 1 to ${ceiling}.`,
      `Set ${key} to a whole number from 1 to ${ceiling} (default ${DEFAULT_INVENTORY_LIMITS[name]}), or unset it to use the default.`,
      { fix: readFix('Removes the override so the default bound applies.', { argv: ['gbrain', 'config', 'unset', key] }) });
  }
  return Number(value);
}

export async function readInventoryLimits(engine: { getConfig(key: string): Promise<string | null> }): Promise<InventoryLimits> {
  const limits = { ...DEFAULT_INVENTORY_LIMITS };
  for (const name of Object.keys(limits) as Array<keyof InventoryLimits>) {
    const value = await engine.getConfig(inventoryLimitKey(name));
    if (value !== null) limits[name] = parseInventoryLimitValue(inventoryLimitKey(name), value);
  }
  return limits;
}
