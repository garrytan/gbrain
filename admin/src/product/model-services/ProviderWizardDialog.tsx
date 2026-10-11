import { Eye, X } from "lucide-react";

import { draftMark, requestPath } from "./support";
import type { ModelServicesController } from "./useModelServices";

export function ProviderWizardDialog({ model }: { model: ModelServicesController }) {
  const { notice, adding, setAdding, showKey, finishProvider } = model;
  const desktop = model.desktop!;
  const service = model.service!;
  return (
    <>
      {adding && (
        <div className="model-modal-overlay">
          <section className="model-modal" role="dialog" aria-modal="true" aria-label="添加自定义提供商">
            <header>
              <h2>添加自定义提供商</h2>
              <button type="button" aria-label="关闭添加服务商" onClick={() => setAdding(null)}>
                <X size={18} />
              </button>
            </header>
            <div className="provider-draft-mark" aria-hidden="true">
              {draftMark(adding.name)}
            </div>
            <label>
              提供商名称 *
              <input
                value={adding.name}
                onChange={(event) => setAdding({ ...adding, name: event.target.value, error: "" })}
                placeholder="例如 OpenAI"
              />
            </label>
            <label>
              API 密钥
              <div className="key-box draft-key">
                <input
                  type={adding.showKey ? "text" : "password"}
                  autoComplete="off"
                  value={adding.key}
                  placeholder="输入 API 密钥"
                  onChange={(event) => setAdding({ ...adding, key: event.target.value, error: "" })}
                />
                <button
                  type="button"
                  className="key-eye"
                  aria-label={adding.showKey ? "隐藏密钥" : "显示密钥"}
                  onClick={() => setAdding({ ...adding, showKey: !adding.showKey })}
                >
                  <Eye size={16} />
                </button>
              </div>
            </label>
            <div className="endpoint-block">
              <b>端点设置</b>
              <label>
                OpenAI
                <input
                  value={adding.url}
                  placeholder="Base URL：https://example.com"
                  onChange={(event) => setAdding({ ...adding, url: event.target.value, error: "" })}
                />
              </label>
              <p className="model-hint">
                {requestPath(adding.url)
                  ? `实际请求路径 ${requestPath(adding.url)}`
                  : "填写 API 根地址后会显示实际请求路径"}
              </p>
            </div>
            <p className="model-hint">名称、密钥和地址在确认前不会保存。这里只保存一份 OpenAI 兼容地址。</p>
            {adding.error && (
              <p className="model-notice" role="alert">
                {adding.error}
              </p>
            )}
            <footer className="spread">
              <button type="button" onClick={() => setAdding(null)}>
                取消
              </button>
              <button type="button" className="model-primary" onClick={() => void finishProvider(true)}>
                添加
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
