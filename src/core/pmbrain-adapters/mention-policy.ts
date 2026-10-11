export const CJK_PLAIN_MENTION_BLOCKLIST = ['系统', '项目', '模型', '平台', '方案', '功能', '问题', '数据', '内容', '工作', '研究', '产品', '用户', '技术', '公司'] as const;
import type {BrainEngine} from '../engine.ts';
import {parseNameList} from '../mentions/policy.ts';
export async function readChineseMentionStopwords(engine:Pick<BrainEngine,'getConfig'>):Promise<string[]>{
  const value=await engine.getConfig('mentions.chinese_stopwords');
  return (value===null||value===undefined?[...CJK_PLAIN_MENTION_BLOCKLIST]:parseNameList(value)).map(n=>n.normalize('NFKC').trim()).filter(Boolean).sort();
}
export async function isCrossSourceLinksEnabled(_engine?: unknown): Promise<boolean> { return false; }
export function isBlockedPlainMentionSurface(name: string,words:readonly string[]=CJK_PLAIN_MENTION_BLOCKLIST): boolean {
  return words.includes(name.normalize('NFKC').trim()) || /^\p{Script=Han}$/u.test(name.normalize('NFKC').trim());
}
