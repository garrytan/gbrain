import { OperationError } from './contract.ts';

export async function once(put: () => Promise<void>): Promise<boolean> {
  try {
    await put();
    return true;
  } catch (error) {
    if (error instanceof OperationError && error.code === 'page_not_found') return false;
    throw error;
  }
}

export async function each(slugs: string[], put: (slug: string) => Promise<void>, log: (e: unknown) => void): Promise<void> {
  for (const slug of slugs) {
    try { await put(slug); } catch (error) { log(error); }
  }
}
