import type { ModelServicesController } from "./useModelServices";

export function ModelRoles({ model }: { model: ModelServicesController }) {
  const { setup, busy, roles, ocrEnabled, setOcrEnabled, applyRoles, chooseRole, options, embeddingOptions } = model;
  return (
    <>
      <header>
        <div>
          <h2>知识库模型配置</h2>
          <p className="model-hint">从已启用的平台中选择模型，无需重复填写密钥和地址。切换后自动保存。</p>
        </div>
      </header>
      <fieldset disabled={busy || !setup} className="model-roles">
        <label className="model-role ocr-enabled">
          <span>
            <b>启用图片与文档 OCR</b>
          </span>
          <input
            className="settings-switch"
            type="checkbox"
            checked={ocrEnabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              setOcrEnabled(enabled);
              void applyRoles(roles, enabled);
            }}
          />
        </label>
        {(
          [
            ["chat", "普通模型", "日常问答、内容理解与常规整理", options],
            ["image", "OCR 模型", "图片与文档 OCR；未指定时沿用普通模型", options],
            ["embedding", "向量模型", "知识检索与向量化。更换已有向量模型前会先确认。", embeddingOptions],
          ] as const
        ).map(([key, label, description, choices]) => (
          <label className="model-role" key={key}>
            <span>
              <b>{label}</b>
              <small>{description}</small>
            </span>
            <select
              aria-label={label}
              value={roles[key]}
              onChange={(event) => chooseRole(key, event.target.value, [...choices])}
            >
              {key !== "embedding" || !roles.embedding ? (
                <option value="">{key === "chat" || key === "embedding" ? "尚未配置" : "沿用普通模型"}</option>
              ) : null}
              {roles[key] && !choices.some((item) => item.value === roles[key]) && (
                <option value={roles[key]}>{roles[key]}（现有配置）</option>
              )}
              {choices.map((item) => (
                <option value={item.value} key={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>
    </>
  );
}
