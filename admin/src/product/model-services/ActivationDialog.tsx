import { Check, Circle, X } from "lucide-react";

import type { ModelServicesController } from "./useModelServices";

export function ActivationDialog({ model }: { model: ModelServicesController }) {
  const { activating, setActivating, busy, checkAndEnable } = model;
  const desktop = model.desktop!;
  const service = model.service!;
  return (
    <>
      {activating && (
        <div className="model-modal-overlay">
          <section className="model-modal" role="dialog" aria-modal="true" aria-label={`${service.name} · 检测并启用`}>
            <header>
              <h2>{service.name} · 检测并启用</h2>
              <button type="button" aria-label="关闭检测并启用" onClick={() => setActivating(null)}>
                <X size={18} />
              </button>
            </header>
            <ol className="activate-steps">
              <li className="done">
                <Check size={16} />
                添加所选模型
              </li>
              <li className={activating.phase === "done" ? "done" : ""}>
                {activating.phase === "done" ? <Check size={16} /> : <Circle size={16} />}
                验证 {activating.model.name}
              </li>
              <li className={activating.phase === "done" ? "done" : ""}>
                {activating.phase === "done" ? <Check size={16} /> : <Circle size={16} />}
                启用服务商
              </li>
            </ol>
            {activating.error && (
              <p className="model-sync-error" role="alert">
                {activating.error}
              </p>
            )}
            <footer className="spread">
              <span />
              {activating.phase === "done" ? (
                <button type="button" className="model-primary" onClick={() => setActivating(null)}>
                  完成
                </button>
              ) : (
                <button
                  type="button"
                  className="model-primary"
                  disabled={activating.phase === "checking" || busy}
                  onClick={() => void checkAndEnable()}
                >
                  {activating.phase === "checking" ? "正在检测" : "检测并启用"}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
