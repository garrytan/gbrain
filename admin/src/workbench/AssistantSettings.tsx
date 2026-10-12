import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { FALLBACK_CONTEXT_TOKENS, normalizeAssistant, type KnowledgeAssistantSettings, type WorkbenchModel } from '../../../shared/workbench';
import { workbenchRequest } from './useWorkbench';

const steps = [['profile', '基础信息'], ['prompt', '系统提示词'], ['knowledge', '知识库'], ['context', '上下文']] as const;

export function AssistantSettings({ value, models, onClose, onSave }: { value: KnowledgeAssistantSettings; models: WorkbenchModel[]; onClose: () => void; onSave: (value: KnowledgeAssistantSettings) => Promise<void> }) {
  const [step, setStep] = useState<(typeof steps)[number][0]>('profile');
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [memory,setMemory]=useState<{mode:'off'|'salient'|'all';ttl:string;sources:Array<{id:string;name:string}>;issues:string[]}>();
  useEffect(()=>{let cancelled=false;void workbenchRequest<NonNullable<typeof memory>>('/memory').then(result=>{if(!cancelled)setMemory(result);}).catch(reason=>{if(!cancelled)setError(String(reason));});return()=>{cancelled=true;};},[]);
  const selected = models.find(model => model.id === (draft.model || models[0]?.id));
  const windowTokens = selected?.contextWindow || FALLBACK_CONTEXT_TOKENS;
  const save = async () => {
    setSaving(true); setError('');
    try {
      const next = normalizeAssistant(draft);
      await onSave({...next,...(memory?{memoryWriteback:{mode:memory.mode,ttl:memory.ttl}}:{})});
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return <div className="wb-modal-overlay"><section className="wb-assistant-dialog" role="dialog" aria-modal="true" aria-label="知识库助手设置"><header><h2>知识库助手</h2><button type="button" aria-label="关闭助手设置" onClick={onClose}><X size={18} /></button></header>
    <div className="wb-assistant-body"><nav aria-label="助手设置">{steps.map(([id, label], index) => <button type="button" key={id} aria-current={step === id ? 'step' : undefined} onClick={() => setStep(id)}><span>{index + 1}</span>{label}</button>)}</nav>
      <div className="wb-assistant-form">
        {step === 'profile' && <><label>头像和名称<div className="wb-name-row"><input aria-label="助手头像" value={draft.emoji} maxLength={8} onChange={event => setDraft({ ...draft, emoji: event.target.value })} /><input aria-label="助手名称" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></div></label><label>模型<select aria-label="助手默认模型" value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })}><option value="">沿用对话里选择的模型</option>{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><label>描述<textarea aria-label="助手描述" value={draft.description} placeholder="描述它的用途…" onChange={event => setDraft({ ...draft, description: event.target.value })} /></label><label>温度<input aria-label="温度" type="number" min="0" max="2" step="0.1" placeholder="留空则使用模型默认" value={draft.temperature ?? ''} onChange={event => setDraft({ ...draft, temperature: event.target.value === '' ? null : Number(event.target.value) })} /></label></>}
        {step === 'prompt' && <label>系统提示词<textarea aria-label="系统提示词" className="wb-prompt" value={draft.systemPrompt} placeholder="留空时使用知识库助手的默认提示：用中文回答，并延续这段对话。检索到的资料和更早对话的摘要仍会附在提示后面。" onChange={event => setDraft({ ...draft, systemPrompt: event.target.value })} /></label>}
        {step === 'knowledge' && <><label className="wb-check"><input type="checkbox" checked={draft.knowledge} onChange={event => setDraft({ ...draft, knowledge: event.target.checked })} />新对话默认检索当前知识库和相关记忆</label><p>打开后，新对话自动使用相关资料和记忆；已打开的对话仍可在输入框旁边单独开关。</p>{memory&&<><label>长期记忆<select aria-label="长期记忆" value={memory.mode} onChange={event=>setMemory({...memory,mode:event.target.value as typeof memory.mode})}><option value="off">关闭自动沉淀</option><option value="salient">自动沉淀重要信息</option><option value="all">自动沉淀直接表达的事实</option></select></label><label>记忆知识来源<select aria-label="记忆知识来源" value={draft.memorySourceId??'default'} onChange={event=>setDraft({...draft,memorySourceId:event.target.value})}>{memory.sources.map(source=><option key={source.id} value={source.id}>{source.name}</option>)}</select></label><label>临时记忆有效期<input aria-label="临时记忆有效期" value={memory.ttl} onChange={event=>setMemory({...memory,ttl:event.target.value})}/></label><p>保存一次后，普通对话也会在后台沉淀；事实、决定和长期偏好保留，临时状态按有效期过期。此开关也用于已接入的外部 AI。新来源用于新对话，历史对话不自动回填。</p>{memory.issues?.length>0&&<p role="status">{memory.issues.join('；')}</p>}</>}</>}
        {step === 'context' && <><label>最大上下文消息数<input aria-label="最大上下文消息数" type="number" min="2" max="500" step="1" value={draft.context.maxMessages} onChange={event => setDraft({ ...draft, context: { ...draft.context, maxMessages: Number(event.target.value) } })} /></label><label>压缩阈值（%）<input aria-label="压缩阈值" type="number" min="50" max="95" step="1" value={Math.round(draft.context.threshold * 100)} onChange={event => setDraft({ ...draft, context: { ...draft.context, threshold: Number(event.target.value) / 100 } })} /></label><label>摘要模型<select aria-label="摘要模型" value={draft.context.summaryModel} onChange={event => setDraft({ ...draft, context: { ...draft.context, summaryModel: event.target.value } })}><option value="">与对话模型相同</option>{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><p>按所选模型的上下文长度估算。到达阈值后，把更早的完整消息压成摘要再继续聊，原来的对话仍留在这个会话里。{selected?.contextWindow ? `当前模型的上下文长度是 ${selected.contextWindow} token。` : `模型没有填写上下文长度时，按 ${windowTokens} token 估算。可以在模型设置里填写。`}</p></>}
        {error && <p role="alert">{error}</p>}
      </div></div>
    <footer><button type="button" onClick={onClose}>取消</button><span>{step !== 'context' && <button type="button" onClick={() => setStep(steps[steps.findIndex(item => item[0] === step) + 1][0])}>下一步</button>}<button type="button" className="wb-primary" disabled={saving} onClick={() => void save()}>{saving ? '保存中' : '保存'}</button></span></footer>
  </section></div>;
}
