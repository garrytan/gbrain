import { describe, expect, test } from 'bun:test';
import { formatEmbeddingInput } from '../../src/core/ai/model-resolver.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

describe('formatEmbeddingInput', () => {
  test('formats titled and untitled EmbeddingGemma documents, including tagged models', () => {
    expect(formatEmbeddingInput('body', 'ollama:embeddinggemma', {
      inputType: 'document',
      documentTitle: 'A real title',
    })).toBe('title: A real title | text: body');
    expect(formatEmbeddingInput('body', 'ollama:embeddinggemma', {
      documentTitle: ' A real title ',
    })).toBe('title:  A real title  | text: body');
    expect(formatEmbeddingInput('body', 'ollama:EmbeddingGemma:latest')).toBe(
      'title: none | text: body',
    );
    expect(formatEmbeddingInput('body', 'ollama:embeddinggemma:300m')).toBe(
      'title: none | text: body',
    );
    for (const documentTitle of ['', ' \n\t']) {
      expect(formatEmbeddingInput('body', 'ollama:embeddinggemma', {
        documentTitle,
      })).toBe('title: none | text: body');
    }
  });

  test('leaves query inputs unchanged, including already-prefixed queries', () => {
    for (const query of [
      'find a result',
      'task: search result | query: find a result',
      'custom query prefix: find a result',
    ]) {
      expect(formatEmbeddingInput(query, 'ollama:embeddinggemma', {
        inputType: 'query',
        documentTitle: 'ignored for queries',
      })).toBe(query);
    }
  });

  test('preserves empty input so the existing refusal remains possible', () => {
    expect(formatEmbeddingInput('', 'ollama:embeddinggemma')).toBe('');
    expect(formatEmbeddingInput(' \n ', 'ollama:embeddinggemma')).toBe(' \n ');
    expect(formatEmbeddingInput(null as unknown as string, 'ollama:embeddinggemma')).toBeNull();
  });

  test('keeps other, unknown, and historical model inputs byte-identical', () => {
    for (const model of [
      'ollama:nomic-embed-text',
      'ollama:embeddinggemma-preview',
      'ollama:embeddinggemma2:latest',
      'voyage:embeddinggemma:latest',
      'openai:embeddinggemma:latest',
      'unknown:embeddinggemma:latest',
      'embeddinggemma:latest',
      null,
    ]) {
      expect(formatEmbeddingInput(' body\n', model)).toBe(' body\n');
    }
  });

  test('applies an Ollama recipe alias before checking the model family', () => {
    const recipe = getRecipe('ollama')!;
    const aliases = recipe.aliases;
    recipe.aliases = { ...aliases, 'gemma-docs': 'embeddinggemma:latest' };
    try {
      expect(formatEmbeddingInput('body', 'ollama:gemma-docs')).toBe(
        'title: none | text: body',
      );
    } finally {
      recipe.aliases = aliases;
    }
  });
});
