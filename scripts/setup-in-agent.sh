#!/usr/bin/env bash
# Non-root runtime trampoline. All ownership/init/repair policy lives in the
# package's src/core/agent-install service; this script never writes the brain.
set -euo pipefail
umask 077

gbrain_root=''
gbrain_harness=''
gbrain_upgrade=0
gbrain_extra=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root|--harness)
      [[ $# -ge 2 && "$2" != --* ]] || { echo "Missing value for $1" >&2; exit 2; }
      if [[ "$1" == --root ]]; then gbrain_root=$2; else gbrain_harness=$2; fi
      shift 2 ;;
    --upgrade) gbrain_upgrade=1; gbrain_extra+=("$1"); shift ;;
    --adopt|--json) gbrain_extra+=("$1"); shift ;;
    -h|--help)
      echo 'setup-in-agent.sh --root ABS --harness grok-bot|muse [--adopt] [--upgrade] [--json]'
      echo 'Repeat setup to repair the recorded runtime; memory is never reset.'
      exit 0 ;;
    *) echo "Unknown setup option: $1" >&2; exit 2 ;;
  esac
done

# The retained helper can recover its own root, without a user-home convention.
if [[ -z "$gbrain_root" && "$(basename "${BASH_SOURCE[0]}")" == gbrain-setup ]]; then
  gbrain_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
fi
[[ "$gbrain_root" == /* && "$gbrain_root" != / && "$gbrain_root" != *'/../'* && "$gbrain_root" != *'/..' && "$gbrain_root" != *$'\n'* ]] || {
  echo 'Provide an absolute persistent --root without traversal.' >&2; exit 2;
}
gbrain_receipt="$gbrain_root/.gbrain/agent-install/receipt.json"
if [[ -z "$gbrain_harness" && -f "$gbrain_receipt" ]]; then
  gbrain_harness=$(sed -n 's/.*"harness": *"\([a-z-]*\)".*/\1/p' "$gbrain_receipt" | head -1)
fi
[[ "$gbrain_harness" == grok-bot || "$gbrain_harness" == muse ]] || { echo '--harness must be grok-bot or muse.' >&2; exit 2; }
for gbrain_tool in curl unzip git; do
  command -v "$gbrain_tool" >/dev/null || { echo "Setup needs $gbrain_tool available in the agent environment." >&2; exit 1; }
done

# The runtime pin follows the repository's supported CI release. Repair reads
# its prior version from the non-secret receipt; no mutable latest runtime URL.
gbrain_bun_version=1.3.13
gbrain_source_ref=''
if [[ -f "$gbrain_receipt" && "$gbrain_upgrade" == 0 ]]; then
  gbrain_prior_bun=$(sed -n 's/.*"bun_version": *"\([0-9.]*\)".*/\1/p' "$gbrain_receipt" | head -1)
  [[ -z "$gbrain_prior_bun" ]] || gbrain_bun_version=$gbrain_prior_bun
  gbrain_source_ref=$(sed -n 's/.*"source_ref": *"\([a-f0-9]*\)".*/\1/p' "$gbrain_receipt" | head -1)
fi
[[ "$gbrain_bun_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid recorded Bun version; preserve the receipt and repair it.' >&2; exit 1; }
if [[ -z "$gbrain_source_ref" ]]; then
  # Resolve the stable tag once; the installed receipt records this immutable
  # commit, so an ordinary repair never upgrades the software implicitly.
  gbrain_refs=$(git ls-remote https://github.com/garrytan/gbrain.git 'refs/tags/latest-stable' 'refs/tags/latest-stable^{}')
  gbrain_source_ref=$(printf '%s\n' "$gbrain_refs" | awk '/\^\{\}$/ {print $1; found=1} END {if (!found) exit 1}') || gbrain_source_ref=$(printf '%s\n' "$gbrain_refs" | awk 'NR==1 {print $1}')
fi
[[ "$gbrain_source_ref" =~ ^[a-f0-9]{40}$ ]] || { echo 'Could not resolve the GBrain package commit.' >&2; exit 1; }

gbrain_work=$(mktemp -d "${TMPDIR:-/tmp}/gbrain-setup.XXXXXXXX")
trap 'rm -rf -- "$gbrain_work"' EXIT
mkdir "$gbrain_work/bundle" "$gbrain_work/bundle/app"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) gbrain_asset=bun-linux-x64-baseline ;;
  Linux:aarch64|Linux:arm64) gbrain_asset=bun-linux-aarch64 ;;
  Darwin:arm64) gbrain_asset=bun-darwin-aarch64 ;;
  Darwin:x86_64) gbrain_asset=bun-darwin-x64-baseline ;;
  *) echo 'Unsupported runtime platform; use a supported Linux or macOS Bun runtime.' >&2; exit 1 ;;
esac
gbrain_release="https://github.com/oven-sh/bun/releases/download/bun-v$gbrain_bun_version"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --max-time 180 "$gbrain_release/$gbrain_asset.zip" -o "$gbrain_work/bun.zip"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --max-time 60 "$gbrain_release/SHASUMS256.txt" -o "$gbrain_work/checksums"
gbrain_expected=$(awk -v file="$gbrain_asset.zip" '$2 == file {print $1}' "$gbrain_work/checksums")
[[ "$gbrain_expected" =~ ^[a-f0-9]{64}$ ]] || { echo 'Runtime release has no unambiguous checksum for this platform.' >&2; exit 1; }
if command -v sha256sum >/dev/null; then
  gbrain_actual=$(sha256sum "$gbrain_work/bun.zip" | awk '{print $1}')
else
  gbrain_actual=$(shasum -a 256 "$gbrain_work/bun.zip" | awk '{print $1}')
fi
[[ "$gbrain_actual" == "$gbrain_expected" ]] || { echo 'Bun archive checksum verification failed.' >&2; exit 1; }
unzip -q "$gbrain_work/bun.zip" -d "$gbrain_work/unpacked"
cp "$gbrain_work/unpacked/$gbrain_asset/bun" "$gbrain_work/bundle/bun"
chmod 700 "$gbrain_work/bundle/bun"

# Isolate package installation from a Bot's other project/database environment.
# Keep this pre-Bun policy identical to agent-install/environment.ts; the
# recipe-coverage/parity test pins the standalone trampoline's literal pattern.
for gbrain_env_name in $(compgen -e); do
  case "$gbrain_env_name" in
    GBRAIN_*|ANTHROPIC_*|AZURE_OPENAI_*|DASHSCOPE_*|DEEPSEEK_*|GEMINI_*|GOOGLE_GENERATIVE_AI_*|GROQ_*|LITELLM_*|LLAMA_SERVER_*|LMSTUDIO_*|MINIMAX_*|MISTRAL_*|MOONSHOT_*|NAN_*|NVIDIA_*|OLLAMA_*|OPENAI_*|OPENROUTER_*|PERPLEXITY_*|TOGETHER_*|VOYAGE_*|ZEROENTROPY_*|ZHIPUAI_*|DATABASE_URL|BUN_OPTIONS|NODE_OPTIONS|CLAUDE_CODE_OAUTH_TOKEN|*_API_KEY|*_API_TOKEN|*_CLIENT_SECRET) unset "$gbrain_env_name" ;;
  esac
done
export GBRAIN_HOME="$gbrain_work/setup-home" GBRAIN_SKIP_STARTUP_HOOKS=1
export BUN_INSTALL_CACHE_DIR="$gbrain_work/cache"
printf '{"private":true,"dependencies":{"gbrain":"github:garrytan/gbrain#%s"}}\n' "$gbrain_source_ref" > "$gbrain_work/bundle/app/package.json"
"$gbrain_work/bundle/bun" install --cwd "$gbrain_work/bundle/app" --ignore-scripts >&2
"$gbrain_work/bundle/bun" --no-env-file "$gbrain_work/bundle/app/node_modules/gbrain/src/core/agent-install/entry.ts" \
  --root "$gbrain_root" --harness "$gbrain_harness" --bundle "$gbrain_work/bundle" --source-ref "$gbrain_source_ref" "${gbrain_extra[@]}"
