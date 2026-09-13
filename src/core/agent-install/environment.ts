/** Provider state belongs to the selected private installation. Remove whole
 * supported provider prefixes: endpoints, tenancy and auth mode can redirect a
 * key subsequently loaded from config.json just as credentials can override it.
 * Recipe-coverage and standalone-shell parity are checked in agent-install tests. */
export const AGENT_PROVIDER_ENV_PREFIXES = [
  'ANTHROPIC_', 'AZURE_OPENAI_', 'DASHSCOPE_', 'DEEPSEEK_', 'GEMINI_',
  'GOOGLE_GENERATIVE_AI_', 'GROQ_', 'LITELLM_', 'LLAMA_SERVER_', 'LMSTUDIO_',
  'MINIMAX_', 'MISTRAL_', 'MOONSHOT_', 'NAN_', 'NVIDIA_', 'OLLAMA_',
  'OPENAI_', 'OPENROUTER_', 'PERPLEXITY_', 'TOGETHER_', 'VOYAGE_',
  'ZEROENTROPY_', 'ZHIPUAI_',
] as const;

const exact = ['DATABASE_URL', 'BUN_OPTIONS', 'NODE_OPTIONS', 'CLAUDE_CODE_OAUTH_TOKEN'];
const suffixes = ['_API_KEY', '_API_TOKEN', '_CLIENT_SECRET'];
const prefixes = ['GBRAIN_', ...AGENT_PROVIDER_ENV_PREFIXES];

export function shouldDropAgentEnv(key: string): boolean {
  return exact.includes(key) || prefixes.some(prefix => key.startsWith(prefix))
    || suffixes.some(suffix => key.endsWith(suffix));
}

/** Literal bash case alternatives only; never interpolate environment values. */
export const AGENT_ENV_SHELL_PATTERN = [
  ...prefixes.map(prefix => `${prefix}*`), ...exact, ...suffixes.map(suffix => `*${suffix}`),
].join('|');
