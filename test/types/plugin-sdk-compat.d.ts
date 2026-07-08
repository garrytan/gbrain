declare module 'open\u0063law/plugin-sdk' {
  export function registerContextEngine(id: string, factory: () => unknown): void;
}
