import React, { useState } from 'react';
import { desktopApi } from '../lib/product-fetch';
import type { AdvancedModelConfig, AdvancedModelWriteInput } from '../../../desktop/src/main/advanced-model-config';

const labels: Record<string, string> = { utility: '轻量任务', reasoning: '推理任务', deep: '深度任务', subagent: '子代理任务', synthesize: '综合整理', synthesize_verdict: '整理判断', patterns: '模式发现', extract_atoms: '知识点提取', synthesize_concepts: '概念综合', consolidate: '知识合并', conversation_facts_backfill: '会话事实整理', capture_entities: '识别实体', propose_takes: '观点生成', grade_takes: '观点评估', calibration_profile: '质量校准' };
export function AdvancedModelRoutes({ options, onSaved }: { options: Array<{ value: string; label: string }>; onSaved: () => void }) {
  const [config, setConfig] = useState<AdvancedModelConfig>();
  const [changes, setChanges] = useState<AdvancedModelWriteInput>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const load = async () => {
    if (config || busy) return;
    setBusy(true);
    try { setConfig(await desktopApi()!.getAdvancedModelConfig()); } catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setNotice('');
    try { setConfig(await desktopApi()!.saveAdvancedModelConfig(changes)); setChanges({}); setNotice('高级模型配置已保存'); onSaved(); }
    catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  };
  return <details className="advanced-routes" onToggle={e => { if (e.currentTarget.open) void load(); }}><summary>高级任务与整理阶段模型</summary><p className="model-hint">保留原有任务层级与 Dream 阶段配置。留空时沿用原来的继承规则。</p>{config && <fieldset disabled={busy}>{(['tiers', 'phases'] as const).map(group => <div key={group}><h3>{group === 'tiers' ? '任务层级' : '知识整理阶段'}</h3>{Object.entries(config[group]).map(([key, route]) => { const value = (changes[group] as Record<string, string> | undefined)?.[key] ?? route.override; return <label className="model-role" key={key}><span><b>{labels[key] || key}</b><small>当前：{route.resolved || '沿用普通模型'}</small></span><select aria-label={labels[key] || key} value={value} onChange={e => setChanges(old => ({ ...old, [group]: { ...old[group], [key]: e.target.value } }))}><option value="">跟随默认配置</option>{value && !options.some(m => m.value === value) && <option value={value}>{value}（现有配置）</option>}{options.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>; })}</div>)}<button disabled={busy || !Object.keys(changes).length} onClick={() => void save()}>保存高级模型配置</button></fieldset>}{notice && <p role="status">{notice}</p>}{!config && !busy && notice && <button onClick={() => void load()}>重新读取</button>}</details>;
}
