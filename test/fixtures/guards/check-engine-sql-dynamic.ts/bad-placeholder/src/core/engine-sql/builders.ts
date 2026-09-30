// Guard self-test fixture stub: builder names the guard registers or rejects.
export function pageReadFilter(alias: string): string {
  return `${alias}.deleted_at IS NULL`;
}

export function unvettedFilter(alias: string): string {
  return `${alias}.deleted_at IS NULL`;
}

export interface Db {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
}
