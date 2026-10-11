/**
 * AI service error hierarchy. Three classes mapping to caller decisions:
 *
 *   AIConfigError     — user fixes: bad key, missing model, dim mismatch.
 *                       Abort + show recovery recipe.
 *   AITransientError  — retryable: SDK retries exhausted, rate limit sustained.
 *                       Propagate so job queue can retry later.
 *   AIServiceError    — base class for both.
 *
 * The `fix` field carries a human-readable recovery recipe agents and humans
 * can act on. The `cause` field preserves the underlying SDK error.
 */

export class AIServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AIServiceError';
  }
}

export class AIConfigError extends AIServiceError {
  constructor(
    message: string,
    public readonly fix?: string,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = 'AIConfigError';
  }
}

export class AITransientError extends AIServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'AITransientError';
  }
}

export type ChatErrorKind='auth'|'billing'|'model_not_found'|'rate_limit'|'provider_5xx'|'timeout'|'network'|'parse'|'failure';

function errorSignals(error:unknown):{status?:number;text:string;names:string;codes:string}{
  let status:number|undefined;const texts:string[]=[],names:string[]=[],codes:string[]=[];const seen=new Set<unknown>();
  for(let current=error,i=0;current&&typeof current==='object'&&i<5&&!seen.has(current);i++){
    seen.add(current);const value=current as Record<string,unknown>;
    const candidate=value.status??value.statusCode;
    if(status===undefined&&typeof candidate==='number')status=candidate;
    for(const key of ['message','responseBody'])if(typeof value[key]==='string')texts.push(value[key] as string);
    if(typeof value.name==='string')names.push(value.name);
    if(typeof value.code==='string')codes.push(value.code);
    current=value.cause??value.lastError;
  }
  if(typeof error==='string')texts.push(error);
  return {status,text:texts.join('\n'),names:names.join(' '),codes:codes.join(' ')};
}

function parameterRejected(error:unknown,pattern:RegExp):boolean{
  const signals=errorSignals(error);
  return (signals.status===400||signals.status===422)&&pattern.test(signals.text);
}

export function isStructuredOutputRejection(error:unknown):boolean{return parameterRejected(error,/response_format|json_schema|structured[ _-]?outputs?/i);}
export function isReasoningControlRejection(error:unknown):boolean{return parameterRejected(error,/enable_thinking|chat_template_kwargs|reasoning_effort|thinking(?:Config|Budget)?[^\n]*(?:unsupported|unknown|not supported|invalid)/i);}
export function isToolCallingRejection(error:unknown):boolean{return parameterRejected(error,/(?:tools?|function calling)[^\n]*(?:unsupported|unknown|not supported|not allowed)|(?:unsupported|unknown|not supported)[^\n]*(?:tools?|function calling)/i);}

export function classifyChatError(error:unknown):ChatErrorKind{
  const value=errorSignals(error);
  if(value.status===401||value.status===403)return 'auth';
  if(value.status===402)return 'billing';
  if(value.status===404)return 'model_not_found';
  if(value.status===429)return 'rate_limit';
  if(value.status!==undefined&&value.status>=500)return 'provider_5xx';
  if(/timeout|timed out/i.test(value.names+' '+value.text))return 'timeout';
  if(/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|unable to connect|network|socket.*(?:closed|reset)|connection.*(?:closed|reset)|完整结束标记/i.test(value.codes+' '+value.names+' '+value.text))return 'network';
  if(/JSON|parse|malformed|choices|invalid response/i.test(value.names+' '+value.text))return 'parse';
  return 'failure';
}

/**
 * Normalize any thrown error into our hierarchy. AI SDK errors are inspected
 * by status code + name; unknown errors default to AITransientError so the
 * caller does not permanently abort on a transient network blip.
 */
export function normalizeAIError(err: unknown, context?: string): AIServiceError {
  if (err instanceof AIServiceError) return err;

  const anyErr = err as { name?: string; status?: number; statusCode?: number; message?: string };
  const status = anyErr?.status ?? anyErr?.statusCode;
  const name = anyErr?.name ?? '';
  const msg = anyErr?.message ?? String(err);
  const ctxPrefix = context ? `[${context}] ` : '';

  // 4xx (except 429) = config-level, non-retryable
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    return new AIConfigError(
      `${ctxPrefix}${msg}`,
      status === 401 || status === 403
        ? 'Check your API key is valid and has access to this model.'
        : 'Check your model id + provider options match the provider API.',
      err,
    );
  }

  // AI SDK named errors
  if (name === 'LoadAPIKeyError' || name === 'InvalidArgumentError') {
    return new AIConfigError(`${ctxPrefix}${msg}`, undefined, err);
  }

  // Everything else (5xx, timeouts, network) = transient
  return new AITransientError(`${ctxPrefix}${msg}`, err);
}
