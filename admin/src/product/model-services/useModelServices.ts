import { useEffect, useRef, useState } from "react";
import type { DesktopSetupState, StartupProgress } from "../../../../desktop/src/preload";
import {
  SERVICE_KEY_PAGES,
  availableServiceModels,
  isCustomProvider,
  listedServiceModels,
  mergeServiceModels,
  presetBaseUrl,
  serviceConnection,
  serviceEndpointError,
  serviceModelValue,
  serviceModelsNotOnRemote,
  serviceNeedsApiKey,
  type ModelService,
  type ModelServicesState,
  type ServiceModel,
} from "../../../../shared/model-services";
import { desktopApi } from "../../lib/product-fetch";

import {
  PickerFilter,
  ProviderWizard,
  errorText,
  friendlyModelError,
  isPictureModel,
  sameServices,
  withoutApiKey,
} from "./support";
export function useModelServices({ mode }: { mode: "services" | "roles" }) {
  const desktop = desktopApi();
  const [state, setState] = useState<ModelServicesState>();
  const [selected, setSelected] = useState("ollama");
  const [query, setQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [ocrEnabled, setOcrEnabled] = useState(true);
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [editor, setEditor] = useState<ServiceModel | null>(null);
  const [originalId, setOriginalId] = useState("");
  const [editorError, setEditorError] = useState("");
  const [adding, setAdding] = useState<ProviderWizard | null>(null);
  const [keyEditor, setKeyEditor] = useState<{
    value: string;
    show: boolean;
    error: string;
  } | null>(null);
  const [endpointEditor, setEndpointEditor] = useState<{
    value: string;
    error: string;
  } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [clearingKey, setClearingKey] = useState(false);
  const [catalog, setCatalog] = useState<ServiceModel[] | null>(null);
  const [syncQuery, setSyncQuery] = useState("");
  const [syncFilter, setSyncFilter] = useState<PickerFilter>("all");
  const [syncWarnings, setSyncWarnings] = useState<string[]>([]);
  const [syncError, setSyncError] = useState("");
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [activating, setActivating] = useState<{
    model: ServiceModel;
    phase: "ready" | "checking" | "done" | "failed";
    error: string;
  } | null>(null);
  const [setup, setSetup] = useState<DesktopSetupState>();
  const [progress, setProgress] = useState<StartupProgress>();
  const [roles, setRoles] = useState({ chat: "", image: "", embedding: "" });
  const stateRef = useRef(state);
  const savedRef = useRef(state);
  const selectedRef = useRef(selected);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastSaveError = useRef("");
  const chain = useRef(Promise.resolve());
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const replaceState = (next: ModelServicesState) => {
    stateRef.current = next;
    setState(next);
  };
  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    if (!desktop || conflictRef.current) return;
    const run = async () => {
      if (conflictRef.current) return;
      const current = stateRef.current;
      const saved = savedRef.current;
      if (!current || !saved || sameServices(current.services, saved.services)) return;
      const problem = current.services.map(serviceEndpointError).find(Boolean);
      if (problem) return;
      try {
        const stored = await desktop.saveModelServices({
          services: current.services,
          revision: saved.revision,
        });
        savedRef.current = stored;
        const latest = stateRef.current;
        if (!latest || sameServices(latest.services, current.services)) {
          replaceState(stored);
          setNotice("已保存");
        } else
          replaceState({
            services: latest.services,
            revision: stored.revision,
          });
        lastSaveError.current = "";
        setSaveError("");
        window.dispatchEvent(new Event("pmbrain:models-updated"));
        if (stateRef.current && savedRef.current && !sameServices(stateRef.current.services, savedRef.current.services))
          await run();
      } catch (error) {
        lastSaveError.current = errorText(error);
        setNotice(lastSaveError.current);
        setSaveError(lastSaveError.current);
        if (lastSaveError.current.startsWith("配置已变化")) {
          conflictRef.current = true;
          setConflict(true);
        }
      }
    };
    const job = chain.current.then(run, run);
    chain.current = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  };
  flushRef.current = flush;
  const schedule = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flushRef.current();
    }, 500);
  };
  const load = async () => {
    if (!desktop) return;
    try {
      const [next, config] = await Promise.all([desktop.getModelServices(), desktop.getSetup(true)]);
      savedRef.current = next;
      replaceState(next);
      conflictRef.current = false;
      setConflict(false);
      setSaveError("");
      lastSaveError.current = "";
      setNotice("");
      setSetup(config);
      setOcrEnabled(config.setup.current.ocrEnabled ?? false);
      setRoles({
        chat: config.setup.current.chatModel || "",
        image: config.setup.current.ocrModel || "",
        embedding: config.setup.current.embeddingModel || "",
      });
    } catch (error) {
      setNotice(errorText(error));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => desktop?.onStartupProgress(setProgress), []);
  useEffect(() => {
    setNotice("");
    setKeyEditor(null);
    setEndpointEditor(null);
    setAdding(null);
    setRemoving(false);
    setClearingKey(false);
  }, [mode]);
  useEffect(() => {
    if (savedRef.current) void flushRef.current();
  }, [mode]);
  useEffect(() => {
    const save = () => {
      void flushRef.current();
    };
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      if (timer.current) clearTimeout(timer.current);
      void flushRef.current();
    };
  }, []);
  useEffect(() => {
    if (!editor && !adding && !catalog && !keyEditor && !endpointEditor && !removing && !clearingKey && !activating)
      return;
    setEditorError("");
    const dialog = document.querySelector<HTMLElement>(".model-modal");
    (dialog?.querySelector<HTMLElement>("input") ?? dialog?.querySelector<HTMLElement>("button"))?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setEditor(null);
        setAdding(null);
        setCatalog(null);
        setKeyEditor(null);
        setEndpointEditor(null);
        setRemoving(false);
        setClearingKey(false);
        setActivating(null);
      }
      if (event.key !== "Tab" || !dialog) return;
      const targets = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input, select")).filter(
        (item) => item.offsetParent !== null,
      );
      const first = targets[0];
      const last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [
    Boolean(editor),
    Boolean(adding),
    Boolean(catalog),
    Boolean(keyEditor),
    Boolean(endpointEditor),
    removing,
    clearingKey,
    Boolean(activating),
  ]);
  const service = state?.services.find((item) => item.id === selected) ?? state?.services[0];
  if (service) selectedRef.current = service.id;
  const roleNamesFor = (item: ModelService, model: ServiceModel) => {
    const value = serviceModelValue(item, model);
    return [
      roles.chat === value ? "普通模型" : "",
      roles.image && roles.image === value ? "OCR 模型" : "",
      roles.embedding === value ? "向量模型" : "",
    ].filter(Boolean);
  };
  const rejectUsedModel = (item: ModelService, model: ServiceModel) => {
    const names = roleNamesFor(item, model);
    if (!names.length) return false;
    setNotice(`当前模型正在作为「${names.join("、")}」使用，请先切换模型后再移除。`);
    return true;
  };
  const rejectUsedProvider = (item: ModelService) => {
    const names = [...new Set(item.models.flatMap((model) => roleNamesFor(item, model)))];
    if (!names.length) return false;
    setNotice(`当前模型正在作为「${names.join("、")}」使用，请先切换模型后再移除。`);
    return true;
  };
  const deleteProvider = async () => {
    const current = stateRef.current;
    const id = selectedRef.current;
    const target = current?.services.find((item) => item.id === id);
    if (!current || !target || !isCustomProvider(target)) return;
    if (rejectUsedProvider(target)) {
      setRemoving(false);
      return;
    }
    const index = current.services.findIndex((item) => item.id === id);
    const services = current.services.filter((item) => item.id !== id);
    const nextSelected = services[Math.min(index, services.length - 1)]?.id ?? "";
    replaceState({ ...current, services });
    selectedRef.current = nextSelected;
    setSelected(nextSelected);
    setRemoving(false);
    setModelQuery("");
    await flush();
  };
  const commit = (recipe: (service: ModelService) => ModelService, immediate = false): Promise<void> => {
    const current = stateRef.current;
    if (!current) return Promise.resolve();
    const id = selectedRef.current;
    const next = {
      ...current,
      services: current.services.map((item) => (item.id === id ? recipe(item) : item)),
    };
    replaceState(next);
    setNotice("");
    if (immediate) {
      const problem = next.services.map(serviceEndpointError).find(Boolean);
      if (problem) {
        setNotice(problem);
        return Promise.resolve();
      }
      return flush() ?? Promise.resolve();
    }
    schedule();
    return Promise.resolve();
  };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice("");
    try {
      await action();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const openCatalog = () =>
    perform(async () => {
      const current = stateRef.current?.services.find((item) => item.id === selectedRef.current);
      if (!desktop || !current) return;
      const problem = serviceEndpointError(current);
      if (problem) throw new Error(problem);
      setSyncQuery("");
      setSyncFilter("all");
      setPickedIds([]);
      setSyncWarnings([]);
      setActivating(null);
      try {
        const result = await desktop.syncServiceModels(current);
        setSyncWarnings(result.warnings);
        setSyncError("");
        setCatalog(result.models);
      } catch (error) {
        setSyncError(friendlyModelError(error));
        setCatalog([]);
      }
    });
  const testConnection = (model?: ServiceModel) =>
    perform(async () => {
      const current = stateRef.current?.services.find((item) => item.id === selectedRef.current);
      if (!desktop || !current) return;
      const chosen = model ?? current.models[0];
      if (!chosen) throw new Error("请先同步模型或手动添加模型");
      if (chosen.kind === "unknown") throw new Error("请先在模型设置中确认这是普通模型还是向量模型");
      const connection = serviceConnection(current, chosen.kind === "embedding" ? "embedding" : "chat");
      const result = await desktop.testModelConnection({
        provider: current.provider,
        ...connection,
        model: chosen.id,
        touchpoint: chosen.kind === "embedding" ? "embedding" : "chat",
        expectedDimensions: chosen.dimensions,
      });
      if (result.status === "success" && result.dimensions)
        commit(
          (item) => ({
            ...item,
            models: item.models.map((entry) =>
              entry.id === chosen.id ? { ...entry, dimensions: result.dimensions } : entry,
            ),
          }),
          true,
        );
      setNotice(
        result.status === "success"
          ? `${chosen.name} 连接成功 · ${result.durationMs} ms${result.dimensions ? ` · ${result.dimensions} 维` : ""}`
          : friendlyModelError(result.message, "验证"),
      );
    });
  const applyRoles = (nextRoles: typeof roles, nextOcr: boolean) =>
    perform(async () => {
      if (!desktop) return;
      if (!nextRoles.chat) throw new Error("请选择普通模型");
      await flush();
      if (stateRef.current && savedRef.current && !sameServices(stateRef.current.services, savedRef.current.services)) {
        throw new Error(
          stateRef.current.services.map(serviceEndpointError).find(Boolean) ||
            "模型服务还没保存成功，请先检查 API 地址",
        );
      }
      const current = (await desktop.getSetup(true)).setup.current;
      const embeddingChanged = nextRoles.embedding !== current.embeddingModel && Boolean(current.embeddingModel);
      const dimension = stateRef.current?.services
        .flatMap((item) =>
          item.models.map((model) => ({
            value: serviceModelValue(item, model),
            dimensions: model.dimensions,
          })),
        )
        .find((model) => model.value === nextRoles.embedding)?.dimensions;
      try {
        const next = await desktop.saveSetup({
          expectedModelRevision: savedRef.current?.revision,
          engine: current.engine,
          databasePath: current.databasePath,
          databaseUrl: current.databaseUrl,
          resetAdvancedModelRouting: false,
          confirmEmbeddingRebuild: embeddingChanged,
          modelConfig: {
            chatModel: nextRoles.chat,
            ...(nextRoles.embedding ? { embeddingModel: nextRoles.embedding } : {}),
            ...(embeddingChanged && dimension ? { embeddingDimensions: dimension } : {}),
            ocrEnabled: nextOcr,
            ocrModel: nextRoles.image,
          },
        });
        setSetup(next);
        const services = await desktop.getModelServices();
        savedRef.current = services;
        if (stateRef.current && sameServices(stateRef.current.services, services.services)) replaceState(services);
        else if (stateRef.current)
          replaceState({
            services: stateRef.current.services,
            revision: services.revision,
          });
        setOcrEnabled(next.setup.current.ocrEnabled ?? nextOcr);
        setRoles({
          chat: next.setup.current.chatModel || nextRoles.chat,
          image: next.setup.current.ocrModel || "",
          embedding: next.setup.current.embeddingModel || "",
        });
        setNotice(next.reembeddingWarning || "已保存");
        window.dispatchEvent(new Event("pmbrain:models-updated"));
      } catch (error) {
        const detail = errorText(error);
        if (detail.startsWith("配置已变化")) {
          conflictRef.current = true;
          setConflict(true);
          setSaveError(detail);
          throw error;
        }
        const fresh = await desktop.getSetup(true);
        setSetup(fresh);
        setOcrEnabled(fresh.setup.current.ocrEnabled ?? false);
        setRoles({
          chat: fresh.setup.current.chatModel || "",
          image: fresh.setup.current.ocrModel || "",
          embedding: fresh.setup.current.embeddingModel || "",
        });
        throw error;
      }
    });
  const chooseRole = (
    key: "chat" | "image" | "embedding",
    value: string,
    choices: Array<{ value: string; label: string }>,
  ) => {
    if (key === "chat" && !value) {
      setNotice("请选择普通模型");
      return;
    }
    if (key === "embedding" && roles.embedding && value !== roles.embedding) {
      const label = choices.find((item) => item.value === value)?.label || value;
      if (
        !window.confirm(
          `向量模型将更换为 ${label}。这会清除旧文本向量并重新向量化，可能耗时和产生 API 费用。原始文档、页面和分块保留。确认更改？`,
        )
      )
        return;
    }
    const next = { ...roles, [key]: value };
    setRoles(next);
    void applyRoles(next, ocrEnabled);
  };
  const saveKey = async (thenSync: boolean) => {
    if (!keyEditor) return;
    const value = keyEditor.value.trim();
    const current = stateRef.current?.services.find((item) => item.id === selectedRef.current);
    if (!current) return;
    if (!value) {
      setKeyEditor({ ...keyEditor, error: "请填写 API 密钥" });
      return;
    }
    const id = current.id;
    const draft = { ...keyEditor, value };
    lastSaveError.current = "";
    await commit(
      (item) => ({
        ...item,
        apiKey: value,
        connections: item.connections?.embedding
          ? { embedding: { ...item.connections.embedding, apiKey: value } }
          : item.connections,
      }),
      true,
    );
    if (lastSaveError.current || stateRef.current?.services.find((item) => item.id === id)?.apiKey !== value) {
      setKeyEditor({
        ...draft,
        error: lastSaveError.current || "密钥没有保存",
      });
      return;
    }
    setKeyEditor(null);
    if (thenSync) await openCatalog();
  };
  const saveEndpoint = async () => {
    if (!endpointEditor) return;
    const current = stateRef.current?.services.find((item) => item.id === selectedRef.current);
    if (!current) return;
    const baseUrl = endpointEditor.value.trim();
    const problem = serviceEndpointError({ name: current.name, baseUrl });
    if (problem) {
      setEndpointEditor({
        ...endpointEditor,
        error: problem.replace(`${current.name}：`, ""),
      });
      return;
    }
    const id = current.id;
    lastSaveError.current = "";
    await commit((item) => ({ ...item, baseUrl, connections: undefined }), true);
    if (lastSaveError.current || stateRef.current?.services.find((item) => item.id === id)?.baseUrl !== baseUrl) {
      setEndpointEditor({
        value: baseUrl,
        error: lastSaveError.current || "地址没有保存",
      });
      return;
    }
    setEndpointEditor(null);
  };
  const finishProvider = async (thenSync: boolean) => {
    const draft = adding;
    const current = stateRef.current;
    if (!draft || !current) return;
    const name = draft.name.trim();
    const baseUrl = draft.url.trim();
    const key = draft.key.trim();
    if (!name) {
      setAdding({ ...draft, error: "请填写提供商名称" });
      return;
    }
    const problem = serviceEndpointError({ name, baseUrl });
    if (problem) {
      setAdding({
        ...draft,
        name,
        url: baseUrl,
        error: problem.replace(`${name}：`, ""),
      });
      return;
    }
    if (serviceNeedsApiKey("service-custom", baseUrl) && !key) {
      setAdding({ ...draft, name, url: baseUrl, error: "请填写 API 密钥" });
      return;
    }
    const id = `service-${crypto.randomUUID()}`;
    const previousId = selectedRef.current;
    const created: ModelService = {
      id,
      provider: id,
      name,
      baseUrl,
      apiKey: key,
      enabled: true,
      models: [],
    };
    lastSaveError.current = "";
    replaceState({ ...current, services: [...current.services, created] });
    selectedRef.current = id;
    setSelected(id);
    setModelQuery("");
    await flush();
    if (lastSaveError.current || !stateRef.current?.services.some((item) => item.id === id)) {
      selectedRef.current = previousId;
      setSelected(previousId);
      setAdding({
        ...draft,
        name,
        url: baseUrl,
        key,
        error: lastSaveError.current || "没有保存",
      });
      return;
    }
    setAdding(null);
    if (thenSync) await openCatalog();
  };
  const openKeyEditor = () => {
    const current = stateRef.current?.services.find((item) => item.id === selectedRef.current);
    setEndpointEditor(null);
    setClearingKey(false);
    setKeyEditor({ value: current?.apiKey ?? "", show: false, error: "" });
  };
  const copyKey = async () => {
    const value = stateRef.current?.services.find((item) => item.id === selectedRef.current)?.apiKey ?? "";
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setNotice("已复制 API 密钥");
    } catch {
      setNotice("复制失败，请在编辑窗口里手动复制");
    }
  };
  const askClearKey = () => {
    const current = stateRef.current?.services.find((item) => item.id === selectedRef.current);
    if (!current?.apiKey) return;
    if (rejectUsedProvider(current)) return;
    setKeyEditor(null);
    setEndpointEditor(null);
    setAdding(null);
    setClearingKey(true);
  };
  const confirmClearKey = async () => {
    const current = stateRef.current?.services.find((item) => item.id === selectedRef.current);
    if (!current?.apiKey) {
      setClearingKey(false);
      return;
    }
    if (rejectUsedProvider(current)) {
      setClearingKey(false);
      return;
    }
    const disable = current.enabled && serviceNeedsApiKey(current.provider, current.baseUrl);
    setClearingKey(false);
    await commit((item) => withoutApiKey(item, disable), true);
  };
  const enableProvider = (enabled: boolean) => {
    const current = stateRef.current?.services.find((item) => item.id === selectedRef.current);
    if (!current) return;
    if (enabled && serviceNeedsApiKey(current.provider, current.baseUrl) && !current.apiKey) {
      setNotice("请先添加 API 密钥");
      openKeyEditor();
      return;
    }
    void commit((item) => ({ ...item, enabled }), true);
  };
  const addPickedModels = async () => {
    const current = stateRef.current?.services.find((item) => item.id === selectedRef.current);
    const remote = catalog;
    if (!current || !remote) return;
    const chosen = remote.filter(
      (model) => pickedIds.includes(model.id) && !current.models.some((item) => item.id === model.id),
    );
    if (!chosen.length) return;
    const probe = chosen.find((model) => model.kind === "chat" && !isPictureModel(model)) ?? chosen[0];
    lastSaveError.current = "";
    await commit((item) => ({ ...item, models: mergeServiceModels(item.models, chosen) }), true);
    if (lastSaveError.current) {
      setSyncError(lastSaveError.current);
      return;
    }
    setCatalog(null);
    setPickedIds([]);
    setActivating({ model: probe, phase: "ready", error: "" });
  };
  const checkAndEnable = () =>
    perform(async () => {
      if (!activating || !desktop) return;
      const current = stateRef.current?.services.find((item) => item.id === selectedRef.current);
      if (!current) return;
      const model = activating.model;
      setActivating({ model, phase: "checking", error: "" });
      const touchpoint = model.kind === "embedding" ? "embedding" : "chat";
      const connection = serviceConnection(current, touchpoint);
      const result = await desktop.testModelConnection({
        provider: current.provider,
        ...connection,
        model: model.id,
        touchpoint,
        expectedDimensions: model.dimensions,
      });
      if (result.status === "error") {
        setActivating({
          model,
          phase: "failed",
          error: friendlyModelError(result.message, "验证"),
        });
        return;
      }
      if (!stateRef.current?.services.find((item) => item.id === current.id)?.enabled) {
        lastSaveError.current = "";
        await commit((item) => ({ ...item, enabled: true }), true);
        if (lastSaveError.current) {
          setActivating({
            model,
            phase: "failed",
            error: lastSaveError.current,
          });
          return;
        }
      }
      setActivating({ model, phase: "done", error: "" });
    });
  const keyRequired = serviceNeedsApiKey(service?.provider ?? "", service?.baseUrl ?? "");
  const keyPage = SERVICE_KEY_PAGES[service?.provider ?? ""];
  const defaultUrl = presetBaseUrl(service?.provider ?? "");
  const disableOnClear = service?.enabled && keyRequired;
  const matches = listedServiceModels(service?.models ?? [], modelQuery);
  const options = availableServiceModels(state?.services ?? [], "chat");
  const embeddingOptions = availableServiceModels(state?.services ?? [], "embedding");
  const pickerListed = catalog
    ? listedServiceModels(catalog, syncQuery).filter((model) =>
        syncFilter === "text"
          ? model.kind === "chat" && !isPictureModel(model)
          : syncFilter === "image"
            ? isPictureModel(model)
            : syncFilter === "embedding"
              ? model.kind === "embedding"
              : true,
      )
    : [];
  const stale = catalog ? serviceModelsNotOnRemote(service?.models ?? [], catalog) : [];
  const selectableIds = pickerListed
    .filter((model) => !service?.models.some((item) => item.id === model.id))
    .map((model) => model.id);
  const allPicked = selectableIds.length > 0 && selectableIds.every((id) => pickedIds.includes(id));
  const openEndpointEditor = () => {
    setKeyEditor(null);
    setClearingKey(false);
    setEndpointEditor({ value: service?.baseUrl ?? "", error: "" });
  };
  return {
    saveError,
    conflict,
    syncFilter,
    setSyncFilter,
    modelQuery,
    setModelQuery,
    progress,
    activating,
    setActivating,
    setup,
    notice,
    setNotice,
    selected,
    setSelected,
    adding,
    setAdding,
    syncWarnings,
    busy,
    syncError,
    setSyncError,
    state,
    roles,
    query,
    setQuery,
    pickedIds,
    setPickedIds,
    originalId,
    setOriginalId,
    catalog,
    setCatalog,
    keyEditor,
    setKeyEditor,
    editor,
    setEditor,
    endpointEditor,
    setEndpointEditor,
    syncQuery,
    setSyncQuery,
    removing,
    setRemoving,
    clearingKey,
    setClearingKey,
    editorError,
    setEditorError,
    showKey,
    setShowKey,
    ocrEnabled,
    setOcrEnabled,
    desktop,
    flush,
    load,
    service,
    rejectUsedModel,
    rejectUsedProvider,
    deleteProvider,
    commit,
    openCatalog,
    testConnection,
    applyRoles,
    chooseRole,
    saveKey,
    saveEndpoint,
    finishProvider,
    openKeyEditor,
    copyKey,
    askClearKey,
    confirmClearKey,
    enableProvider,
    addPickedModels,
    checkAndEnable,
    keyRequired,
    keyPage,
    defaultUrl,
    disableOnClear,
    matches,
    options,
    embeddingOptions,
    pickerListed,
    stale,
    selectableIds,
    allPicked,
    openEndpointEditor,
  };
}

export type ModelServicesController = ReturnType<typeof useModelServices>;
