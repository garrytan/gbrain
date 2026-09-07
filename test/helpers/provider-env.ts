/** Explicit provider state shared by the unit preload and keyless E2E children.
 * Keep this module pure: importing it must not change the calling test's env.
 * test/provider-fixture-env.test.ts checks the list against the recipe registry.
 */
export const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_USE_ENTRA',
  'DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY', 'GROQ_API_KEY',
  'LITELLM_API_KEY', 'LITELLM_BASE_URL',
  'LLAMA_SERVER_API_KEY', 'LLAMA_SERVER_BASE_URL',
  'LLAMA_SERVER_RERANKER_API_KEY', 'LLAMA_SERVER_RERANKER_BASE_URL',
  'LMSTUDIO_API_KEY', 'LMSTUDIO_BASE_URL', 'MINIMAX_API_KEY', 'MINIMAX_GROUP_ID',
  'MISTRAL_API_KEY', 'MOONSHOT_API_KEY', 'NAN_API_KEY', 'NVIDIA_API_KEY',
  'OLLAMA_API_KEY', 'OLLAMA_BASE_URL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT',
  'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'OPENROUTER_REFERER', 'OPENROUTER_TITLE',
  'PERPLEXITY_API_KEY', 'TOGETHER_API_KEY', 'VOYAGE_API_KEY',
  'ZEROENTROPY_API_KEY', 'ZHIPUAI_API_KEY',
] as const;

type Env = Readonly<Record<string, string | undefined>>;

/** Clones ambient env, removes provider state, then applies explicit overrides.
 * Database policy belongs to the fixture: PGLite removes URLs; Postgres keeps
 * its test URL. Overrides can deliberately inject a provider for a specific test.
 */
export function keylessBrainEnv(parent: Env, home: string, overrides: Env = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of PROVIDER_ENV_KEYS) delete env[key];
  env.HOME = home;
  env.GBRAIN_HOME = home;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
