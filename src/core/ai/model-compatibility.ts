import {resolveRecipe} from './model-resolver.ts';

export const DEFAULT_MAX_OUTPUT_TOKENS=4096;
export const THINKING_MODEL_MAX_OUTPUT_TOKENS=32000;

export function isThinkingModel(model:string|undefined):boolean{
  if(!model)return false;
  try{
    const {recipe,parsed}=resolveRecipe(model);
    const declared=recipe.touchpoints.chat?.thinking_by_default;
    if(declared!==undefined)return typeof declared==='function'?declared(parsed.modelId):declared;
    const name=parsed.modelId.split('/').at(-1)!.toLowerCase();
    if(/(?:coder|embedding|reranker|\basr\b|\btts\b|instruct)/i.test(name))return false;
    return /^(?:qwen3[0-9]*(?:[.\-:]|$)|qwq(?:[.\-:]|$)|deepseek-(?:flash|r\d|reasoner|v4)|gpt-oss(?:[.\-:]|$)|gpt-[56](?:[.\-:]|$)|o[134](?:-|$)|gemini-(?:2\.5|3)(?:[.\-:]|$)|glm-(?:4\.[5-9]|[5-9])|magistral(?:[.\-:]|$)|phi\d+(?:-mini)?-reasoning|claude-[a-z]+-5(?:[.\-:]|$))/.test(name);
  }catch{return false;}
}

export function defaultMaxOutputTokens(model:string|undefined):number{
  return isThinkingModel(model)?THINKING_MODEL_MAX_OUTPUT_TOKENS:DEFAULT_MAX_OUTPUT_TOKENS;
}

export function supportsQwenSoftThinkingSwitch(model:string):boolean{
  const {parsed}=resolveRecipe(model);
  return /(?:^|\/)qwen3(?:[-:]|$|\.[0-4](?:[-:]|$))/i.test(parsed.modelId)
    &&!/(?:coder|embedding|reranker|instruct|thinking)/i.test(parsed.modelId);
}

export function reasoningOffOptions(model:string,baseURL?:string):Record<string,unknown>|undefined{
  const {recipe,parsed}=resolveRecipe(model);
  if(recipe.id==='mimo'||recipe.id==='deepseek')return {thinking:{type:'disabled'}};
  if(recipe.id==='anthropic')return {thinking:{type:'disabled'}};
  if(recipe.id==='google')return {thinkingConfig:{thinkingBudget:0}};
  if(recipe.id==='openai'&&/^gpt-5/i.test(parsed.modelId))return {reasoningEffort:'none'};
  if(recipe.implementation!=='openai-compatible'||!/(?:^|\/)qwen3[0-9]*(?:[.\-:]|$)/i.test(parsed.modelId)||/(?:coder|embedding|reranker|instruct|thinking)/i.test(parsed.modelId))return undefined;
  if(recipe.id==='ollama')return {think:false,reasoningEffort:'none'};
  let host='';try{host=new URL(baseURL??'').hostname;}catch{}
  return recipe.id==='dashscope'||/^(?:dashscope|dashscope-intl)\.aliyuncs\.com$/i.test(host)
    ? {enable_thinking:false}
    : {chat_template_kwargs:{enable_thinking:false}};
}
