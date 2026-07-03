declare module '*/plugin-sdk' {
  export function registerContextEngine(id: string, factory: () => unknown): void;
}
