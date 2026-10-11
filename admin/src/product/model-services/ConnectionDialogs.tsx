import { Eye, X } from "lucide-react";

import { openHttps } from "./support";
import type { ModelServicesController } from "./useModelServices";

export function ConnectionDialogs({ model }: { model: ModelServicesController }) {
  const {
    notice,
    keyEditor,
    setKeyEditor,
    endpointEditor,
    setEndpointEditor,
    removing,
    setRemoving,
    clearingKey,
    setClearingKey,
    deleteProvider,
    saveKey,
    saveEndpoint,
    confirmClearKey,
    keyPage,
    defaultUrl,
    disableOnClear,
  } = model;
  const desktop = model.desktop!;
  const service = model.service!;
  return (
    <>
      {keyEditor && (
        <div className="model-modal-overlay">
          <section
            className="model-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${service.name} · 添加 API 密钥`}
          >
            <header>
              <h2>{service.name} · 添加 API 密钥</h2>
              <button type="button" aria-label="关闭添加密钥" onClick={() => setKeyEditor(null)}>
                <X size={18} />
              </button>
            </header>
            <label>
              API 密钥
              <div className="model-input-row">
                <input
                  type={keyEditor.show ? "text" : "password"}
                  autoComplete="off"
                  placeholder="输入 API 密钥"
                  value={keyEditor.value}
                  onChange={(event) =>
                    setKeyEditor({
                      ...keyEditor,
                      value: event.target.value,
                      error: "",
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={keyEditor.show ? "隐藏密钥" : "显示密钥"}
                  onClick={() => setKeyEditor({ ...keyEditor, show: !keyEditor.show })}
                >
                  <Eye size={16} />
                </button>
              </div>
            </label>
            {keyPage && (
              <button
                type="button"
                className="model-text-button"
                onClick={() => openHttps(desktop.openExternal, keyPage)}
              >
                获取密钥
              </button>
            )}
            {keyEditor.error && (
              <p className="model-notice" role="alert">
                {keyEditor.error}
              </p>
            )}
            <footer className="spread">
              <button type="button" onClick={() => void saveKey(false)}>
                保存并关闭
              </button>
              <button type="button" className="model-primary" onClick={() => void saveKey(true)}>
                下一步
              </button>
            </footer>
          </section>
        </div>
      )}
      {endpointEditor && (
        <div className="model-modal-overlay">
          <section className="model-modal" role="dialog" aria-modal="true" aria-label={`${service.name} · 添加端点`}>
            <header>
              <h2>{service.name} · 添加端点</h2>
              <button type="button" aria-label="关闭添加端点" onClick={() => setEndpointEditor(null)}>
                <X size={18} />
              </button>
            </header>
            <label>
              API 地址
              <input
                value={endpointEditor.value}
                placeholder="https://api.example.com/v1"
                onChange={(event) => setEndpointEditor({ value: event.target.value, error: "" })}
              />
            </label>
            <p className="model-hint">这里只保存一份 OpenAI 兼容地址，对话和向量共用。确认后才会写入。</p>
            {endpointEditor.error && (
              <p className="model-notice" role="alert">
                {endpointEditor.error}
              </p>
            )}
            <footer className="spread">
              {defaultUrl && (
                <button
                  type="button"
                  onClick={() => setEndpointEditor({ value: defaultUrl, error: "" })}
                  disabled={endpointEditor.value.trim() === defaultUrl}
                >
                  恢复默认
                </button>
              )}
              <span className="footer-actions">
                <button type="button" onClick={() => setEndpointEditor(null)}>
                  取消
                </button>
                <button type="button" className="model-primary" onClick={() => void saveEndpoint()}>
                  保存并关闭
                </button>
              </span>
            </footer>
          </section>
        </div>
      )}
      {removing && (
        <div className="model-modal-overlay">
          <section className="model-modal" role="dialog" aria-modal="true" aria-label={`删除 ${service.name}`}>
            <header>
              <h2>删除 {service.name}</h2>
              <button type="button" aria-label="关闭删除服务商" onClick={() => setRemoving(false)}>
                <X size={18} />
              </button>
            </header>
            <p className="model-hint">
              删除后，这个自定义服务商和它已添加的模型会从列表中去掉。正在使用的模型需要先切换。
            </p>
            <footer className="spread">
              <button type="button" onClick={() => setRemoving(false)}>
                取消
              </button>
              <button type="button" className="model-primary" onClick={() => void deleteProvider()}>
                删除
              </button>
            </footer>
          </section>
        </div>
      )}
      {clearingKey && (
        <div className="model-modal-overlay">
          <section className="model-modal" role="dialog" aria-modal="true" aria-label="删除 API 密钥">
            <header>
              <h2>删除 API 密钥</h2>
              <button type="button" aria-label="关闭删除密钥" onClick={() => setClearingKey(false)}>
                <X size={18} />
              </button>
            </header>
            <p className="model-hint">
              {disableOnClear
                ? `删除后将停用${service.name}。没有密钥时，这个服务商不能继续调用。`
                : `删除 ${service.name} 的 API 密钥？`}
            </p>
            <footer className="spread">
              <button type="button" onClick={() => setClearingKey(false)}>
                取消
              </button>
              <button type="button" className="model-danger" onClick={() => void confirmClearKey()}>
                {disableOnClear ? "删除并停用" : "删除"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
