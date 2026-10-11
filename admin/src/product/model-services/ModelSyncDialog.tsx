import { Box, Search, X } from "lucide-react";
import { serviceModelValue } from "../../../../shared/model-services";

import { ModelName, ModelSections, capabilityItems, isPictureModel } from "./support";
import type { ModelServicesController } from "./useModelServices";

export function ModelSyncDialog({ model }: { model: ModelServicesController }) {
  const {
    syncFilter,
    setSyncFilter,
    syncWarnings,
    syncError,
    setSyncError,
    roles,
    pickedIds,
    setPickedIds,
    catalog,
    setCatalog,
    syncQuery,
    setSyncQuery,
    commit,
    openKeyEditor,
    addPickedModels,
    pickerListed,
    stale,
    selectableIds,
    allPicked,
  } = model;
  const desktop = model.desktop!;
  const service = model.service!;
  return (
    <>
      {catalog && (
        <div className="model-modal-overlay">
          <section
            className="model-modal model-sync"
            role="dialog"
            aria-modal="true"
            aria-label={`${service.name} · 选择模型`}
          >
            <header>
              <h2>
                {service.name} · 选择模型<small>{catalog.length}</small>
              </h2>
              <button type="button" aria-label="关闭模型列表" onClick={() => setCatalog(null)}>
                <X size={18} />
              </button>
            </header>
            <div className="sync-head">
              <label className="model-search">
                <Search size={15} />
                <input
                  aria-label="搜索模型列表"
                  placeholder="搜索模型..."
                  value={syncQuery}
                  onChange={(event) => setSyncQuery(event.target.value)}
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  setPickedIds(
                    allPicked
                      ? pickedIds.filter((id) => !selectableIds.includes(id))
                      : [...new Set([...pickedIds, ...selectableIds])],
                  )
                }
              >
                全选
              </button>
            </div>
            <div className="sync-filters">
              {(
                [
                  ["all", "全部", catalog.length],
                  ["text", "文本", catalog.filter((model) => model.kind === "chat" && !isPictureModel(model)).length],
                  ["image", "图片", catalog.filter(isPictureModel).length],
                  ["embedding", "向量", catalog.filter((model) => model.kind === "embedding").length],
                ] as const
              )
                .filter(([, , count]) => count > 0)
                .map(([value, label, count]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={syncFilter === value}
                    onClick={() => setSyncFilter(value)}
                  >
                    {label} {count}
                  </button>
                ))}
            </div>
            {syncWarnings.length > 0 && <p className="model-hint">{syncWarnings.join(" ")}</p>}
            {syncError && (
              <p className="model-sync-error" role="alert">
                {syncError}
              </p>
            )}
            <div className="sync-list service-model-groups">
              <ModelSections
                models={pickerListed}
                renderGroup={(_group, models) => {
                  const ids = models
                    .filter((model) => !service.models.some((item) => item.id === model.id))
                    .map((model) => model.id);
                  const checked = ids.length > 0 && ids.every((id) => pickedIds.includes(id));
                  return (
                    <input
                      className="group-select"
                      type="checkbox"
                      aria-label={`选择 ${_group}`}
                      checked={checked}
                      disabled={!ids.length}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() =>
                        setPickedIds((current) =>
                          checked ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])],
                        )
                      }
                    />
                  );
                }}
                renderRow={(model) => {
                  const added = service.models.some((item) => item.id === model.id);
                  const checked = added || pickedIds.includes(model.id);
                  return (
                    <div className="service-model-row" key={model.id}>
                      <Box size={18} />
                      <ModelName model={model} />
                      <div className="model-badges">
                        {capabilityItems
                          .filter(([value]) => model.capabilities.includes(value))
                          .map(([value, label, Icon]) => (
                            <span key={value} title={label} aria-label={label}>
                              <Icon size={14} />
                            </span>
                          ))}
                      </div>
                      <input
                        type="checkbox"
                        aria-label={added ? `已添加 ${model.name}` : `选择 ${model.name}`}
                        checked={checked}
                        disabled={added}
                        onChange={() =>
                          setPickedIds((current) =>
                            current.includes(model.id)
                              ? current.filter((id) => id !== model.id)
                              : [...current, model.id],
                          )
                        }
                      />
                    </div>
                  );
                }}
              />
              {!pickerListed.length && (
                <p className="models-empty">{syncError ? "没有拉到模型。" : "没有符合条件的模型。"}</p>
              )}
            </div>
            {stale.length > 0 && (
              <button
                type="button"
                className="model-text-button"
                onClick={() => {
                  const used = new Set([roles.chat, roles.image, roles.embedding].filter(Boolean));
                  const removable = stale.filter((model) => !used.has(serviceModelValue(service, model)));
                  if (!removable.length) {
                    setSyncError("这些模型正在使用，请先在知识库模型配置中更换");
                    return;
                  }
                  commit(
                    (item) => ({
                      ...item,
                      models: item.models.filter((model) => !removable.some((entry) => entry.id === model.id)),
                    }),
                    true,
                  );
                }}
              >
                清理未返回的模型
              </button>
            )}
            <footer className="spread">
              <button
                type="button"
                onClick={() => {
                  setCatalog(null);
                  openKeyEditor();
                }}
              >
                修改密钥
              </button>
              <span className="footer-actions">
                <button type="button" onClick={() => setCatalog(null)}>
                  跳过
                </button>
                <button
                  type="button"
                  className="model-primary"
                  disabled={
                    !pickedIds.some((id) =>
                      catalog.some((model) => model.id === id && !service.models.some((item) => item.id === model.id)),
                    )
                  }
                  onClick={() => void addPickedModels()}
                >
                  添加所选模型
                </button>
              </span>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
