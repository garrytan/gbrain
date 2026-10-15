import React, { useEffect, useState } from 'react';
import type { WorkbenchArtifact } from '../../../shared/workbench-agents';
import { workbenchRequest } from './useWorkbench';
import { MarkdownArticle } from '../pages/Documentation';
import { Download, FileText } from 'lucide-react';

export async function downloadArtifact(id: string) {
  const result = await workbenchRequest<{ data: string; mime: string; filename: string }>(`/artifacts/${id}?download=1`);
  const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: result.mime })); const link = document.createElement('a'); link.href = url; link.download = result.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ArtifactPreview({ id, onClose }: { id: string; onClose: () => void }) {
  const [artifact, setArtifact] = useState<WorkbenchArtifact>();
  const [error, setError] = useState('');
  useEffect(() => { let active = true; void workbenchRequest<WorkbenchArtifact>(`/artifacts/${id}`).then(value => { if (active) setArtifact(value); }).catch(reason => { if (active) setError(String(reason)); }); return () => { active = false; }; }, [id]);
  return <div className="wb-modal-overlay"><section className="wb-artifact-preview" role="dialog" aria-modal="true" aria-label="成果预览"><header><div><FileText size={20} /><h2>{artifact?.title || '成果预览'}</h2></div><button aria-label="关闭成果预览" onClick={onClose}>×</button></header><div className="wb-artifact-content">{artifact && <MarkdownArticle markdown={artifact.content} citations={artifact.citations} />}{!artifact && !error && <p role="status">正在读取文件…</p>}{error && <p className="wb-error" role="alert">{error}</p>}</div><footer><small>正文预览 · {artifact?.format === 'docx' ? 'Word 文档' : 'Markdown'}</small><button disabled={!artifact} onClick={() => void downloadArtifact(id).catch(reason => setError(String(reason)))}><Download size={15} />下载文件</button></footer></section></div>;
}
export function Artifacts({ onClose, onConversation }: { onClose: () => void; onConversation: (id: string) => void }) {
  const [rows, setRows] = useState<WorkbenchArtifact[]>([]); const [selected, setSelected] = useState<WorkbenchArtifact>(); const [error, setError] = useState('');
  useEffect(() => { let active = true; void workbenchRequest<{ artifacts: WorkbenchArtifact[] }>('/artifacts').then(result => { if (active) setRows(result.artifacts); }).catch(reason => { if (active) setError(String(reason)); }); return () => { active = false; }; }, []);
  return <div className="wb-modal-overlay"><section className="wb-artifacts-dialog" role="dialog" aria-modal="true" aria-label="工作成果"><header><h2>工作成果</h2><button aria-label="关闭工作成果" onClick={onClose}>×</button></header><div className="wb-artifacts-body"><nav>{rows.map(row => <button key={row.id} onClick={() => void workbenchRequest<WorkbenchArtifact>(`/artifacts/${row.id}`).then(setSelected).catch(reason => setError(String(reason)))}><b>{row.title}</b><small>{row.publishedPath || (row.format === 'docx' ? 'Word' : 'Markdown')} · {new Date(row.createdAt).toLocaleString()}</small></button>)}{!rows.length && <p>助手完成任务后，文件会写入知识来源本地目录，并出现在这里。</p>}</nav><section>{selected && <><h3>{selected.title}</h3>{selected.publishedPath && <p>已保存到 {selected.publishedPath}</p>}<button onClick={() => void downloadArtifact(selected.id).catch(reason => setError(String(reason)))}>下载文件</button><button onClick={() => { onConversation(selected.conversationId); onClose(); }}>在对话里查看</button><MarkdownArticle markdown={selected.content} citations={selected.citations} /></>}{error && <p role="alert">{error}</p>}</section></div></section></div>;
}
