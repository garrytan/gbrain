/** `import p from './x.jsonl' with { type: 'file' }`: the asset's path (source tree in dev, bundler path in a compiled binary). */
declare module '*.jsonl' {
  const path: string;
  export default path;
}
