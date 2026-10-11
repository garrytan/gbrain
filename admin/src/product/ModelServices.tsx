import React from "react";
import { AdvancedModelRoutes } from "./AdvancedModelRoutes";
import { useModelServices } from "./model-services/useModelServices";
import { ProviderList } from "./model-services/ProviderList";
import { ProviderDetail } from "./model-services/ProviderDetail";
import { ModelRoles } from "./model-services/ModelRoles";
import { ModelDialogs } from "./model-services/ModelDialogs";

export function ModelServices({ mode }: { mode: "services" | "roles" }) {
  const model = useModelServices({ mode });
  const { desktop, state, service, notice, busy, progress, setNotice, options, load, catalog, flush } = model;
  if (!desktop)
    return (
      <div className="model-unavailable">
        <h2>模型服务</h2>
        <p>请在 PMBrain 桌面应用中配置模型服务与密钥。</p>
      </div>
    );
  if (!state || !service)
    return (
      <div className="model-unavailable" role="status">
        {notice || "正在读取模型服务…"}
      </div>
    );
  return (
    <div className={`model-services ${mode === "roles" ? "is-roles" : ""}`} aria-busy={busy}>
      {mode === "services" && <ProviderList model={model} />}
      <section className="provider-detail">
        {mode === "services" ? <ProviderDetail model={model} /> : <ModelRoles model={model} />}
        {busy && mode === "roles" && progress?.visible && (
          <div className="model-notice" role="status">
            <strong>{progress.title}</strong>
            <p>{progress.message}</p>
            {progress.canDeferEmbeddingRebuild && (
              <div className="model-input-row">
                <button
                  type="button"
                  onClick={() => {
                    void desktop.chooseEmbeddingRebuild("defer").catch((error: unknown) => setNotice(String(error)));
                  }}
                >
                  稍后在任务中心处理
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void desktop.chooseEmbeddingRebuild("wait").catch((error: unknown) => setNotice(String(error)));
                  }}
                >
                  现在重建索引
                </button>
              </div>
            )}
          </div>
        )}
        {mode === "roles" && (
          <AdvancedModelRoutes
            options={options}
            onSaved={() => {
              void load();
            }}
          />
        )}
        {(notice || model.saveError) && !catalog && (
          <div className="model-notice" role="status">
            <p>{notice || model.saveError}</p>
            {model.saveError && (
              <div className="model-input-row">
                {!model.conflict && (
                  <button type="button" onClick={() => void flush()}>
                    重试保存
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm("重新载入会放弃本页未保存的模型修改，是否继续？")) void load();
                  }}
                >
                  重新载入配置
                </button>
              </div>
            )}
          </div>
        )}
      </section>
      <ModelDialogs model={model} />
    </div>
  );
}
