import { describe, test, expect, beforeEach } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  configureGateway,
  embed,
  isAvailable,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { resolveRecipe } from '../../src/core/ai/model-resolver.ts';

function fakeComposioCli(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-composio-openai-'));
  const cli = join(dir, 'composio');
  writeFileSync(cli, `#!/bin/sh
if [ "$1" != "execute" ] || [ "$2" != "OPENAI_CREATE_EMBEDDINGS" ]; then
  echo "unexpected args: $*" >&2
  exit 2
fi
out='${dir}/embeddings-output.json'
cat > "$out" <<'JSON'
{"data":{"data":[{"object":"embedding","index":0,"embedding":[0,0.01,0.02,0.03]},{"object":"embedding","index":1,"embedding":[1,1.01,1.02,1.03]}],"model":"text-embedding-3-small"}}
JSON
echo 'Update available: ignored by parser'
echo '{"successful":true,"storedInFile":true,"outputFilePath":"${dir}/embeddings-output.json"}'
`);
  chmodSync(cli, 0o700);
  return cli;
}

describe('Composio OpenAI embedding provider', () => {
  beforeEach(() => resetGateway());

  test('recipe is registered and availability is keyed by COMPOSIO_CLI', () => {
    const { recipe, parsed } = resolveRecipe('composio-openai:text-embedding-3-small');
    expect(recipe.id).toBe('composio-openai');
    expect(parsed.modelId).toBe('text-embedding-3-small');

    configureGateway({
      embedding_model: 'composio-openai:text-embedding-3-small',
      embedding_dimensions: 4,
      env: {},
    });
    expect(isAvailable('embedding')).toBe(false);

    resetGateway();
    configureGateway({
      embedding_model: 'composio-openai:text-embedding-3-small',
      embedding_dimensions: 4,
      env: { COMPOSIO_CLI: fakeComposioCli() },
    });
    expect(isAvailable('embedding')).toBe(true);
  });

  test('embeds through the Composio CLI without OPENAI_API_KEY', async () => {
    configureGateway({
      embedding_model: 'composio-openai:text-embedding-3-small',
      embedding_dimensions: 4,
      env: { COMPOSIO_CLI: fakeComposioCli() },
    });

    const vectors = await embed(['first document', 'second document']);

    expect(vectors).toHaveLength(2);
    expect(vectors[0][0]).toBeCloseTo(0);
    expect(vectors[0][3]).toBeCloseTo(0.03);
    expect(vectors[1][0]).toBeCloseTo(1);
    expect(vectors[1][3]).toBeCloseTo(1.03);
  });
});
