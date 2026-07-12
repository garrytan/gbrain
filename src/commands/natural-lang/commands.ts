import { basename, resolve } from 'path';
import type { IntentPreview } from './types.ts';

/**
 * 解析当前运行环境下的 CLI 入口命令前缀。
 * - 如果当前进程是用 pmbrain-sidecar.js 启动的（生产环境打包），
 *   返回 ['bun', '<pmbrain-sidecar.js 的绝对路径>']。
 * - 如果当前进程是用 src/cli.ts 启动的（开发环境），
 *   使用本文件的绝对路径推导项目根目录，拼接 src/cli.ts 的绝对路径，
 *   避免全局命令启动时 process.cwd() 不在项目目录导致子进程找不到入口文件。
 */
export function resolveCliEntry(): string[] {
  const arg1 = process.argv[1] ?? '';
  const entryName = basename(arg1);
  if (entryName === 'pmbrain-sidecar.js') {
    // 生产环境：sidecar 已编译为单个 JS 文件
    return ['bun', arg1];
  }
  // 开发环境：使用绝对路径，不依赖 process.cwd()
  const cliPath = resolve(import.meta.dir, '..', '..', '..', 'src', 'cli.ts');
  return ['bun', 'run', cliPath];
}

export function commandForPreview(preview: IntentPreview): string[] {
  const s = preview.slots;
  const prefix = resolveCliEntry();
  switch (preview.intent) {
    case 'capture_memory':
      return [...prefix, 'capture', String(s.content ?? '')];
    case 'search_brain':
      return [...prefix, 'think', String(s.query ?? ''), '--json'];
    case 'import_path': {
      const cmd = [...prefix, 'import', String(s.path ?? '')];
      if (s.includeOffice !== false) cmd.push('--include-office');
      if (s.includeImages === true) cmd.push('--include-images');
      if (typeof s.sourceId === 'string' && s.sourceId.trim()) cmd.push('--source-id', s.sourceId.trim());
      return cmd;
    }
    case 'sync_source':
      return [...prefix, 'sync', '--source', String(s.sourceId ?? '')];
    case 'sync_all':
      return [...prefix, 'sync', '--all'];
    case 'embed_stale':
      return [...prefix, 'embed', '--stale'];
    case 'show_sources':
      return [...prefix, 'sources', 'list', '--json'];
    case 'show_stats':
      return [...prefix, 'stats'];
    case 'show_config':
      return [...prefix, 'config', 'show'];
    case 'doctor_check':
      return [...prefix, 'doctor', '--fast'];
  }
}
