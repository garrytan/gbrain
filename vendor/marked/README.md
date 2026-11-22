# marked (browser build)

`marked.umd.js` is the unmodified `lib/marked.umd.js` from the installed `marked` package (MIT, license header kept in
the file). `gbrain publish` inlines it into every HTML page it writes, so a shared page renders with no CDN.

It is checked in because a compiled `gbrain` binary has no `node_modules` (#10019), and `marked`'s package exports do
not expose the UMD file to an import. `src/commands/publish.ts` embeds it at build time with
`import ... with { type: 'text' }`.

After a `marked` upgrade, `test/publish-compiled-binary-10019.test.ts` fails until you refresh the copy:

```bash
cp node_modules/marked/lib/marked.umd.js vendor/marked/marked.umd.js
```
