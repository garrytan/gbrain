import { AIConfigError } from './errors.ts';
import type { Recipe } from './types.ts';

/**
 * fetch follows a 307 or 308 and sends the body again, so a redirect from a local model server would move the caller's
 * text to a host nobody configured. A recipe with `compat.refuse_redirects` turns that into a configuration error.
 * This wraps the fetch a call already uses, so a recipe's own wrapper or the asymmetric embedding fetch stays in the path.
 */
export function refusingRedirects(recipe: Recipe, inner?: typeof fetch): typeof fetch | undefined {
  if (!recipe.compat?.refuse_redirects) return inner;
  const next = inner ?? fetch;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await next(input as any, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    throw new AIConfigError(`${recipe.name} answered with a ${response.status} redirect, so the request was not followed and nothing was sent to the new address.`,
      `Set the ${recipe.id} base URL to the server's final address.`);
  }) as unknown as typeof fetch;
}
