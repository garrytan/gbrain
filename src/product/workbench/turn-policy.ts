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

function ruleTopic(rule: string): string {
  return compactRule(rule).replace(/不要|别再|别|不用|无需|不能|禁止|不必|不写|少写|写完整|必须|需要|要写|写成|完整|那么|这个|一下|请|把|都|写|多|少/g, '').replace(/[，。！？、\s]/g, '');
}
function rulePolarity(rule: string): 'forbid' | 'require' | 'other' {
  if (/不要|别|不用|无需|不能|禁止|不写|少写/.test(rule)) return 'forbid';
  if (/要|必须|完整/.test(rule)) return 'require';
  return 'other';
}
export function rulesConflict(left: string, right: string): boolean {
  const topic = ruleTopic(left);
  const other = ruleTopic(right);
  if (topic.length < 2 || other.length < 2 || (!topic.includes(other) && !other.includes(topic))) return false;
  const leftPolarity = rulePolarity(left);
  const rightPolarity = rulePolarity(right);
  return leftPolarity !== 'other' && rightPolarity !== 'other' && leftPolarity !== rightPolarity;
}
export function learnTurn(input: { name: string; standingRules?: string[]; recentUserTexts: string[]; text: string }): { scope: TurnScope; rules: string[]; added: string[]; replaced: Array<{ text: string; replacedBy: string }>; notice?: string; taskNote?: string } {
  const scope = classifyTurn(input.text);
  const current = input.standingRules ?? [];
  if (scope === 'once') return { scope, rules: current, added: [], replaced: [], taskNote: compactRule(input.text) };
  if (scope === 'chat') return { scope, rules: current, added: [], replaced: [] };
  const specific = compactRule(input.text);
  const generic = genericAffirmation.test(specific.replace(/[。！!\s]/g, ''));
  const additions = scope === 'durable' && generic ? input.recentUserTexts.map(compactRule).filter(text => instructional(text) && classifyTurn(text) !== 'once') : [specific];
  const rules = [...current];
  const replaced: Array<{ text: string; replacedBy: string }> = [];
  for (const rule of additions) {
    if (!rule) continue;
    for (let index = rules.length - 1; index >= 0; index -= 1) if (rulesConflict(rules[index]!, rule)) { replaced.push({ text: rules[index]!, replacedBy: rule }); rules.splice(index, 1); }
    if (!rules.includes(rule)) rules.push(rule);
  }
  const capped = rules.slice(-40);
  const added = capped.filter(rule => !current.includes(rule));
  const kept = replaced.filter(item => !capped.includes(item.text));
  const changed = capped.join('\n') !== current.join('\n');
  const notice = !changed ? undefined : kept.length === 1 && added.length === 1 ? `已用「${added[0]}」替代「${kept[0]!.text}」` : scope === 'durable' ? `已更新「${input.name}」工作规则` : `已更新${input.name}规则：${specific}`;
  return { scope, rules: capped, added, replaced: kept, notice };
}
