import { X } from "lucide-react";
import { type ModelCapability, type ServiceModel } from "../../../../shared/model-services";

import { capabilityItems } from "./support";
import type { ModelServicesController } from "./useModelServices";

export function ModelEditorDialog({ model }: { model: ModelServicesController }) {
  const { originalId, editor, setEditor, editorError, setEditorError, commit } = model;
  const desktop = model.desktop!;
  const service = model.service!;
  return (
    <>
      {editor && (
        <div className="model-modal-overlay">
          <section className="model-modal" role="dialog" aria-modal="true" aria-label="模型设置">
            <header>
              <h2>{originalId ? "模型设置" : "添加模型"}</h2>
              <button type="button" aria-label="关闭模型设置" onClick={() => setEditor(null)}>
                <X size={18} />
              </button>
            </header>
            <label>
              模型 ID *
              <input
                required
                value={editor.id}
                onChange={(event) => setEditor({ ...editor, id: event.target.value })}
                placeholder="平台提供的模型 ID"
              />
            </label>
            <label>
              显示名称
              <input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} />
            </label>
            <div className="model-form-grid">
              <label>
                分组
                <input value={editor.group} onChange={(event) => setEditor({ ...editor, group: event.target.value })} />
              </label>
              <label>
                模型类型
                <select
                  value={editor.kind}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      kind: event.target.value as ServiceModel["kind"],
                      typeOverride: true,
                    })
                  }
                >
                  <option value="chat">对话模型</option>
                  <option value="embedding">向量模型</option>
                  <option value="unknown">待确认类型</option>
                </select>
              </label>
            </div>
            {editor.kind === "embedding" && (
              <label>
                向量维度
                <input
                  type="number"
                  min="1"
                  step="1"
                  placeholder="留空后在检测连接时自动识别"
                  value={editor.dimensions ?? ""}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      dimensions: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
                <small>保存用途时仍会通过原有流程验证实际维度。</small>
              </label>
            )}
            <label>能力标签</label>
            <div className="capability-controls">
              {capabilityItems.map(([value, label, Icon]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={editor.capabilities.includes(value)}
                  onClick={() =>
                    setEditor({
                      ...editor,
                      capabilities: editor.capabilities.includes(value)
                        ? editor.capabilities.filter((item) => item !== value)
                        : [...editor.capabilities, value as ModelCapability],
                    })
                  }
                >
                  <Icon size={15} />
                  {label}
                </button>
              ))}
            </div>
            <p className="model-hint">标签用于辨认模型能力，请以平台实际支持为准。</p>
            <details className="model-more" open>
              <summary>价格与更多设置</summary>
              <div className="model-form-grid">
                {(
                  [
                    ["inputPrice", "输入价格", "美元 / 百万 Token，仅作参考"],
                    ["outputPrice", "输出价格", "美元 / 百万 Token，仅作参考"],
                    ["inputPriceCny", "输入价格", "元 / 百万 Token。填写后才统计实体回填费用"],
                    ["outputPriceCny", "输出价格", "元 / 百万 Token。填写后才统计实体回填费用"],
                  ] as const
                ).map(([key, label, hint]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="未设置"
                      value={editor[key] ?? ""}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          [key]: event.target.value === "" ? undefined : Number(event.target.value),
                        })
                      }
                    />
                    <small>{hint}</small>
                  </label>
                ))}
              </div>
              <label>
                上下文长度（Token）
                <input
                  type="number"
                  min="0"
                  value={editor.contextWindow ?? ""}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      contextWindow: event.target.value === "" ? undefined : Number(event.target.value),
                    })
                  }
                />
              </label>
            </details>
            <footer>
              {editorError && <span role="alert">{editorError}</span>}
              <button type="button" onClick={() => setEditor(null)}>
                取消
              </button>
              <button
                type="button"
                className="model-primary"
                onClick={() => {
                  if (!editor.id.trim()) {
                    setEditorError("请填写模型 ID");
                    return;
                  }
                  if (service.models.some((model) => model.id === editor.id.trim() && model.id !== originalId)) {
                    setEditorError("模型 ID 已存在");
                    return;
                  }
                  commit(
                    (item) => ({
                      ...item,
                      models: [
                        ...item.models.filter((model) => model.id !== originalId),
                        {
                          ...editor,
                          id: editor.id.trim(),
                          name: editor.name.trim() || editor.id.trim(),
                          group: editor.group.trim() || "其他模型",
                        },
                      ],
                    }),
                    true,
                  );
                  setEditor(null);
                }}
              >
                确认
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
