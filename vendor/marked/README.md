# marked (browser build)

`marked.umd.js` is the unmodified `lib/marked.umd.js` from the installed `marked` package (MIT, license header kept in
the file). `gbrain publish` inlines it into every HTML page it writes, so a shared page renders with no CDN.

It is checked in because a compiled `gbrain` binary has no `node_modules` (#10019), and `marked`'s package exports do
not expose the UMD file to an import. `marked-source.ts` holds the same file as a string, which `src/commands/publish.ts`
imports, so it is embedded at build time and also loads under Playwright and Node, which ignore
`import ... with { type: 'text' }`. Each `--` in that string is written `-\u002d`, so the CLI flag scanner reads no
flags in it.

After a `marked` upgrade, `test/publish-compiled-binary-10019.test.ts` fails until you refresh both copies:

```bash
cp node_modules/marked/lib/marked.umd.js vendor/marked/marked.umd.js
bun -e 'const fs=require("fs");fs.writeFileSync("vendor/marked/marked-source.ts","export const MARKED_JS = "+JSON.stringify(fs.readFileSync("vendor/marked/marked.umd.js","utf8")).replace(/--/g,"-\\u002d")+";\n")'
```
