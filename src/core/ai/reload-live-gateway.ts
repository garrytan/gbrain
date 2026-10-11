import type { BrainEngine } from '../engine.ts';
import { loadConfig, loadConfigWithEngine } from '../config.ts';
import { buildGatewayConfig } from './gateway-config.ts';
import { configureGateway, reconfigureGatewayWithEngine } from './gateway.ts';

/** Re-read config.json into the already running gateway. Does not restart the process. */
export async function reloadLiveGateway(engine: BrainEngine): Promise<void> {
  const fileConfig = loadConfig();
  if (!fileConfig) throw new Error('PMBrain 配置不存在，无法刷新运行中的模型。');
  const merged = await loadConfigWithEngine(engine, fileConfig).catch(() => fileConfig);
  configureGateway(buildGatewayConfig(merged ?? fileConfig));
  await reconfigureGatewayWithEngine(engine);
}
