import { existsSync, cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const outDir = join(root, 'out')
const distDir = join(root, 'dist')

if (!existsSync(outDir)) {
  throw new Error('Next export did not create admin/out')
}

rmSync(distDir, { recursive: true, force: true })
cpSync(outDir, distDir, { recursive: true })

console.log(`[admin] exported Next app to ${distDir}`)
