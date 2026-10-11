import { BrainCircuit, ChevronDown, Eye, Globe, Wrench } from "lucide-react";
import React from "react";
import { serviceModelSections, type ModelService, type ServiceModel } from "../../../../shared/model-services";

export const capabilityItems = [
  ["vision", "视觉", Eye],
  ["reasoning", "推理", BrainCircuit],
  ["tools", "工具", Wrench],
  ["web", "联网", Globe],
] as const;
export const providerMarks: Record<string, { bg: string; fg: string; text: string }> = {
  ollama: { bg: "#3c3c3c", fg: "#f3f3f3", text: "Ol" },
  deepseek: { bg: "#4d6bfe", fg: "#fff", text: "深" },
  "service-siliconflow": { bg: "#7c4dff", fg: "#fff", text: "硅" },
  zhipu: { bg: "#3d6bdb", fg: "#fff", text: "智" },
  "service-dmxapi": { bg: "#5b4bdb", fg: "#fff", text: "D" },
  "service-qiniu": { bg: "#0e9aa7", fg: "#fff", text: "七" },
  "service-lmstudio": { bg: "#6d5efc", fg: "#fff", text: "LM" },
  "service-moonshot": { bg: "#242424", fg: "#fff", text: "月" },
  "service-baichuan": { bg: "#e25b2a", fg: "#fff", text: "百" },
  mimo: { bg: "#f79848", fg: "#1c1c1c", text: "米" },
  openai: { bg: "#0f8f72", fg: "#fff", text: "OA" },
  anthropic: { bg: "#c96442", fg: "#fff", text: "An" },
  google: { bg: "#4c8bf5", fg: "#fff", text: "Ge" },
  openrouter: { bg: "#5c63f2", fg: "#fff", text: "Or" },
  dashscope: { bg: "#f06a00", fg: "#fff", text: "阿" },
  minimax: { bg: "#d11a45", fg: "#fff", text: "Mi" },
  groq: { bg: "#e24b32", fg: "#fff", text: "Gq" },
  together: { bg: "#0f6e56", fg: "#fff", text: "To" },
  voyage: { bg: "#1d4ed8", fg: "#fff", text: "Vo" },
};
export type PickerFilter = "all" | "text" | "image" | "embedding";
export function isPictureModel(model: ServiceModel): boolean {
  return /image|cogview|dall-e|flux|kolors|stable-diffusion|wanx|gpt-image/i.test(`${model.id} ${model.name}`);
}
export function friendlyModelError(reason: unknown, action: "拉取模型" | "验证" = "拉取模型"): string {
  const raw = (reason instanceof Error ? reason.message : String(reason))
    .replace(/^Error invoking remote method '[^']+': Error:\s*/s, "")
    .trim();
  if (
    raw.startsWith("拉取模型失败") ||
    raw.startsWith("验证失败") ||
    raw.startsWith("请") ||
    raw.startsWith("模型 ") ||
    raw.startsWith("连接成功") ||
    raw.startsWith("连接测试超时") ||
    raw.startsWith("当前模型") ||
    raw.startsWith("配置已变化") ||
    raw.startsWith("该平台") ||
    raw.startsWith("不能移除") ||
    raw.startsWith("无效") ||
    raw.startsWith("密钥没有") ||
    raw.startsWith("地址没有") ||
    raw.startsWith("没有保存")
  )
    return raw;
  if (/401|403|unauthorized|invalid api key|invalid token|authentication/i.test(raw))
    return `${action}失败。API 密钥无效，请检查后重新配置`;
  if (/429|quota|rate limit/i.test(raw)) return `${action}失败。请求过于频繁或额度不足，请稍后再试`;
  if (/404/.test(raw)) return `${action}失败。请检查 API 地址`;
  if (/timeout|超时|network|fetch failed|ECONN|ENOTFOUND|无法连接/i.test(raw))
    return `${action}失败。无法连接到服务，请检查 API 地址和网络`;
  if (/[\u4e00-\u9fff]/.test(raw)) return raw;
  return `${action}失败。请检查密钥、地址和网络后重试`;
}
export function ProviderMark({ service }: { service: ModelService }) {
  const mark = providerMarks[service.provider] ?? {
    bg: "#3a4158",
    fg: "#fff",
    text: service.name.slice(0, 1),
  };
  return (
    <span className="provider-mark" style={{ background: mark.bg, color: mark.fg }} aria-hidden="true">
      {mark.text}
    </span>
  );
}
export function withoutApiKey(item: ModelService, disable: boolean): ModelService {
  const connections = item.connections
    ? {
        ...(item.connections.chat ? { chat: { ...item.connections.chat, apiKey: "" } } : {}),
        ...(item.connections.embedding ? { embedding: { ...item.connections.embedding, apiKey: "" } } : {}),
      }
    : item.connections;
  return {
    ...item,
    apiKey: "",
    enabled: disable ? false : item.enabled,
    connections,
  };
}
export function errorText(reason: unknown) {
  const raw = reason instanceof Error ? reason.message : String(reason);
  return raw.replace(/^Error invoking remote method '[^']+': Error:\s*/s, "").trim();
}
export function sameServices(left: ModelService[], right: ModelService[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}
export type ProviderWizard = {
  name: string;
  url: string;
  key: string;
  showKey: boolean;
  error: string;
};
export function draftMark(name: string): string {
  const text = name.trim();
  return text ? Array.from(text)[0] : "P";
}
export function requestPath(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return `${parsed.href.replace(/\/+$/, "")}/chat/completions`;
  } catch {
    return "";
  }
}
export function openHttps(openExternal: ((url: string) => Promise<void>) | undefined, url: string) {
  if (!url.startsWith("https://")) return;
  if (openExternal) void openExternal(url).catch(() => window.open(url, "_blank", "noreferrer"));
  else window.open(url, "_blank", "noreferrer");
}
export function ModelName({ model }: { model: ServiceModel }) {
  return (
    <div className="service-model-name">
      <b>{model.name}</b>
      {model.name !== model.id && <small>{model.id}</small>}
    </div>
  );
}
export function ModelSections({
  models,
  renderRow,
  renderGroup,
}: {
  models: ServiceModel[];
  renderRow: (model: ServiceModel) => React.ReactNode;
  renderGroup?: (group: string, models: ServiceModel[]) => React.ReactNode;
}) {
  return (
    <>
      {serviceModelSections(models).map((section) =>
        section.group ? (
          <details open key={`group:${section.group}`}>
            <summary>
              <ChevronDown size={16} />
              {section.group}
              {renderGroup?.(section.group, section.models)}
            </summary>
            {section.models.map(renderRow)}
          </details>
        ) : (
          <div className="service-model-flat" key={`flat:${section.models[0]?.id}`}>
            {section.models.map(renderRow)}
          </div>
        ),
      )}
    </>
  );
}
