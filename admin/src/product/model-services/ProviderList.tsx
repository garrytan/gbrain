import { Plus, Search } from "lucide-react";
import { configuredProvidersFirst } from "../../../../shared/model-services";

import { ProviderMark } from "./support";
import type { ModelServicesController } from "./useModelServices";

export function ProviderList({ model }: { model: ModelServicesController }) {
  const {
    setModelQuery,
    setActivating,
    setNotice,
    selected,
    setSelected,
    setAdding,
    busy,
    query,
    setQuery,
    setCatalog,
    setKeyEditor,
    setEndpointEditor,
    setRemoving,
    setClearingKey,
    showKey,
    setShowKey,
    flush,
  } = model;
  const desktop = model.desktop!;
  const service = model.service!;
  const state = model.state!;
  return (
    <>
      <aside className="provider-list">
        <label className="model-search">
          <Search size={16} />
          <input
            placeholder="搜索模型平台…"
            aria-label="搜索模型平台"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="provider-list-scroll">
          {configuredProvidersFirst(
            state.services.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())),
          ).map((item) => (
            <button
              type="button"
              className={item.id === service.id ? "selected" : ""}
              key={item.id}
              disabled={busy}
              onClick={() => {
                setSelected(item.id);
                setModelQuery("");
                setShowKey(false);
                setCatalog(null);
                setActivating(null);
                setKeyEditor(null);
                setEndpointEditor(null);
                setRemoving(false);
                setClearingKey(false);
                setNotice("");
                void flush();
              }}
            >
              <ProviderMark service={item} />
              <span>{item.name}</span>
              {item.enabled && <i aria-label="已启用" />}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="add-provider"
          disabled={busy}
          onClick={() => setAdding({ name: "", url: "", key: "", showKey: false, error: "" })}
        >
          <Plus size={16} />
          添加服务商
        </button>
      </aside>
    </>
  );
}
