export const CHAT_MODEL_KEY = 'pmbrain.workbench.chatModel';
export const CHAT_MODEL_EVENT = 'pmbrain:chat-model';
export const CHAT_MODEL_DEFAULT_KEY = 'pmbrain.workbench.chatModelDefault';

export function rememberedChatModel(remembered: string, settingsModel: string, modelIds: readonly string[]): string {
  if (remembered && modelIds.includes(remembered)) return remembered;
  if (settingsModel && modelIds.includes(settingsModel)) return settingsModel;
  return modelIds[0] ?? '';
}

export function rememberChatModel(id: string, defaultModel = '') {
  if (!id) return;
  try { localStorage.setItem(CHAT_MODEL_KEY, id); localStorage.setItem(CHAT_MODEL_DEFAULT_KEY, defaultModel); } catch { return; }
  window.dispatchEvent(new CustomEvent(CHAT_MODEL_EVENT, { detail: id }));
}
