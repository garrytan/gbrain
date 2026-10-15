export type TurnScope = 'durable' | 'correction' | 'once' | 'chat';

const durableCue = /以后|今后|从今以后|记住|每次|固定这样|固定按|都这么做|一直按|默认都|从现在开始/;
const onceCue = /这次|这一次|本次|就这一次|仅此一次/;
const genericAffirmation = /^(?:以后|今后|记住)?(?:都这么做|照这个做|按这个做|就这样|固定这样)$/;
const correctionCue = /不要这么写|不要这么|标题不要|标题还是|还是按上次|还是按|风险不要|问题只写|只保留|改成|改为/;
const workCue = /周报|生成|写一|写成|按上次|按上周|还是按|继续按|导出|模板|交付|下周计划|本周|整理成|做一份|帮我做|帮我写|保存 Word|写周报/;
const greeting = /^(?:你好|您好|谢谢|感谢|你是谁|你能做什么|在吗)[！!。.?？\s]*$/;

export function compactRule(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

export function classifyTurn(text: string): TurnScope {
  const normalized = text.replace(/\s+/g, '');
  const durable = durableCue.test(normalized) && !/(?:不要|别|不用|无需).{0,4}记住/.test(normalized);
  if (onceCue.test(normalized) && !durable) return 'once';
  if (durable) return 'durable';
  if (correctionCue.test(normalized)) return 'correction';
  return 'chat';
}

export function instructional(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  return normalized.length >= 6 && /不要|先写|再写|然后|格式|模板|依据|编造|标题|风险|结构|Word|按知识库|未解决/.test(normalized);
}

export function taskNeedsSkill(agent: { workflow?: string; skills?: string[] }, text: string): boolean {
  if (!agent.workflow && !(agent.skills?.length)) return false;
  const normalized = text.trim();
  if (!normalized || greeting.test(normalized)) return false;
  return workCue.test(normalized);
}

export function learnTurn(input: { name: string; standingRules?: string[]; recentUserTexts: string[]; text: string }): { scope: TurnScope; rules: string[]; notice?: string; taskNote?: string } {
  const scope = classifyTurn(input.text);
  const current = input.standingRules ?? [];
  if (scope === 'once') return { scope, rules: current, taskNote: compactRule(input.text) };
  if (scope === 'chat') return { scope, rules: current };
  const specific = compactRule(input.text);
  const generic = genericAffirmation.test(specific.replace(/[。！!\s]/g, ''));
  const additions = scope === 'durable' && generic ? input.recentUserTexts.map(compactRule).filter(text => instructional(text) && classifyTurn(text) !== 'once') : [specific];
  const rules = [...current];
  for (const rule of additions) if (rule && !rules.includes(rule)) rules.push(rule);
  const capped = rules.slice(-40);
  const changed = capped.join('\n') !== current.join('\n');
  const notice = !changed ? undefined : scope === 'durable' ? `已更新「${input.name}」工作规则` : `已更新${input.name}规则：${specific}`;
  return { scope, rules: capped, notice };
}
