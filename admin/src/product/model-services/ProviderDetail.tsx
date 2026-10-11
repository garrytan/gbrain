import { Box, Copy, Eye, KeyRound, Minus, Pencil, Plus, RefreshCw, Search, Settings2, Trash2 } from "lucide-react";
import { isCustomProvider, newServiceModel, providerKindLabel } from "../../../../shared/model-services";

import { ModelName, ModelSections, capabilityItems, openHttps } from "./support";
import type { ModelServicesController } from "./useModelServices";

export function ProviderDetail({ model }: { model: ModelServicesController }) {
  const {
    modelQuery,
    setModelQuery,
    selected,
    setAdding,
    busy,
    setOriginalId,
    setCatalog,
    setKeyEditor,
    setEditor,
    setEndpointEditor,
    setRemoving,
    setClearingKey,
    showKey,
    setShowKey,
    rejectUsedModel,
    rejectUsedProvider,
    commit,
    openCatalog,
    testConnection,
    openKeyEditor,
    copyKey,
    askClearKey,
    enableProvider,
    keyRequired,
    keyPage,
    matches,
    openEndpointEditor,
  } = model;
  const desktop = model.desktop!;
  const service = model.service!;
  const state = model.state!;
  return (
    <>
      <header>
        <div>
          <h2>{service.name}</h2>
          <span className="model-subtitle">{providerKindLabel(service)}</span>
        </div>
        <div className="provider-header-actions">
          {isCustomProvider(service) && (
            <button
              type="button"
              title="删除服务商"
              aria-label={`删除 ${service.name}`}
              onClick={() => {
                if (rejectUsedProvider(service)) return;
                setEditor(null);
                setCatalog(null);
                setKeyEditor(null);
                setEndpointEditor(null);
                setAdding(null);
                setClearingKey(false);
                setRemoving(true);
              }}
            >
              <Trash2 size={16} />
            </button>
          )}
          <label className="service-switch">
            <input
              type="checkbox"
              disabled={busy}
              aria-label={`启用 ${service.name}`}
              checked={service.enabled}
              onChange={(event) => enableProvider(event.target.checked)}
            />
            <span />
          </label>
        </div>
      </header>
      <fieldset disabled={busy}>
        {service.legacy && (
          <p className="model-hint">
            已保留原{service.legacy.kind === "chat" ? "普通" : "向量"}模型接口
            {service.legacy.selected ? "，当前正在使用" : ""}。
          </p>
        )}
        {keyRequired && (
          <div className="model-field">
            <div className="model-field-head">
              <span>API 密钥 *</span>
              {keyPage && (
                <button
                  type="button"
                  className="model-text-button"
                  onClick={() => openHttps(desktop.openExternal, keyPage)}
                >
                  获取密钥
                </button>
              )}
            </div>
            <div className="model-input-row">
              <div className="key-box">
                <input
                  readOnly
                  aria-label="添加 API 密钥"
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  placeholder="点击添加 API 密钥"
                  value={service.apiKey}
                  onClick={openKeyEditor}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openKeyEditor();
                    }
                  }}
                />
                <span className="key-hover-actions">
                  {service.apiKey && (
                    <button
                      type="button"
                      aria-label="复制密钥"
                      title="复制"
                      onClick={() => {
                        void copyKey();
                      }}
                    >
                      <Copy size={15} />
                    </button>
                  )}
                  <button type="button" aria-label="编辑密钥" title="编辑" onClick={openKeyEditor}>
                    <Pencil size={15} />
                  </button>
                  {service.apiKey && (
                    <button type="button" aria-label="删除密钥" title="删除" onClick={askClearKey}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </span>
                <button
                  type="button"
                  className="key-eye"
                  aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                  onClick={() => setShowKey(!showKey)}
                >
                  <Eye size={16} />
                </button>
              </div>
              <button type="button" onClick={() => testConnection()}>
                <KeyRound size={15} />
                检测
              </button>
            </div>
          </div>
        )}
        <div className="model-field">
          <div className="model-field-head">
            <span>API 地址 *</span>
            <button type="button" className="model-text-button" onClick={openEndpointEditor}>
              添加端点
            </button>
          </div>
          <div className="model-input-row">
            <input
              readOnly
              aria-label="API 地址"
              value={service.baseUrl}
              onClick={openEndpointEditor}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openEndpointEditor();
                }
              }}
            />
            <button type="button" aria-label="编辑 API 地址" onClick={openEndpointEditor}>
              <Settings2 size={16} />
            </button>
          </div>
        </div>
        <p className="model-hint">
          每个服务商只保存一份 OpenAI
          兼容地址，对话和向量模型都从这里获取。本地服务不需要密钥。密钥和地址都在确认后保存。
        </p>
        <div className="model-list-heading">
          <h3>
            已添加模型 <small>{service.models.length}</small>
          </h3>
          <div>
            <label className="model-search">
              <Search size={15} />
              <input
                aria-label="搜索模型"
                placeholder="搜索模型"
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
              />
            </label>
            <button type="button" onClick={openCatalog}>
              <RefreshCw size={15} />
              同步模型
            </button>
            <button
              type="button"
              aria-label="添加模型"
              onClick={() => {
                setOriginalId("");
                setEditor(newServiceModel(""));
              }}
            >
              <Plus size={18} />
            </button>
          </div>
        </div>
        <p className="model-hint">这里保留已添加和历史配置的模型。同步模型窗口仅显示平台本次在线返回的列表。</p>
        <div className="service-model-groups">
          <ModelSections
            models={matches}
            renderRow={(model) => (
              <div className="service-model-row" key={model.id}>
                <Box size={18} />
                <ModelName model={model} />
                <div className="model-badges">
                  {model.kind === "unknown" && <span title="请设置模型类型">待确认</span>}
                  {model.kind === "embedding" && (
                    <span title="向量模型">
                      <Box size={14} />
                    </span>
                  )}
                  {capabilityItems
                    .filter(([value]) => model.capabilities.includes(value))
                    .map(([value, label, Icon]) => (
                      <span key={value} title={label} aria-label={label}>
                        <Icon size={14} />
                      </span>
                    ))}
                </div>
                <span className="row-actions">
                  <button
                    type="button"
                    title="测试连接"
                    aria-label={`测试 ${model.name}`}
                    onClick={() => testConnection(model)}
                  >
                    <KeyRound size={15} />
                  </button>
                  <button
                    type="button"
                    title="设置模型"
                    aria-label={`设置 ${model.name}`}
                    onClick={() => {
                      setOriginalId(model.id);
                      setEditor(structuredClone(model));
                    }}
                  >
                    <Settings2 size={16} />
                  </button>
                  <button
                    type="button"
                    title="移除模型"
                    aria-label={`移除 ${model.name}`}
                    onClick={() => {
                      if (!service || rejectUsedModel(service, model)) return;
                      commit(
                        (item) => ({
                          ...item,
                          models: item.models.filter((entry) => entry.id !== model.id),
                        }),
                        true,
                      );
                    }}
                  >
                    <Minus size={16} />
                  </button>
                </span>
              </div>
            )}
          />
          {!matches.length && <p className="models-empty">点击「同步模型」，挑选要使用的模型；也可以手动添加。</p>}
        </div>
      </fieldset>
    </>
  );
}
