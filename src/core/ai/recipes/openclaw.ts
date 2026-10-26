import type { Recipe } from '../types.ts';

/** Raw inference through the operator's existing OpenClaw model/auth routing. */
export const openclaw: Recipe = {
  id: 'openclaw',
  name: 'OpenClaw (raw inference)',
  tier: 'native',
  implementation: 'openclaw-cli',
  auth_env: { required: [] },
  // OpenClaw may use a subscription or a metered provider. Never guess its price.
  unpriced_models: ['default'],
  touchpoints: {
    chat: {
      models: ['default'],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      supports_structured_outputs: false,
      default_timeout_ms: 30_000,
    },
  },
  setup_hint: 'Install OpenClaw, configure its model and login, then verify `openclaw infer model run --gateway --json --prompt "Return OK"`. This route uses that configured credential; it does not grant embeddings or API credit.',
};
