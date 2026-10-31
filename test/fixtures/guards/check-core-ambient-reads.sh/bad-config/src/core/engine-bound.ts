export interface Engine { getConfig(key: string): Promise<string | null> }

export async function readSetting(engine: Engine, env: Record<string, string | undefined>): Promise<string | null> {
  return (await engine.getConfig('setting')) ?? env.SETTING ?? null;
}
