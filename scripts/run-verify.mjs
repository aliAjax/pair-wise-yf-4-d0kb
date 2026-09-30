/**
 * 端到端验证运行器：用 esbuild 把 TS 脚本（含 @/ 别名）打成 CJS 后在 Node 执行。
 *   node scripts/run-verify.mjs
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, rmSync } from 'node:fs'

const outfile = 'node_modules/.tmp/verify-ledger.mjs'

await build({
  entryPoints: ['scripts/verify-ledger.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  alias: {
    '@': './src',
  },
})

// esbuild 会把 await import() 的同模块去重，验证脚本依赖“多标签页多实例”，
// 因此直接顺序执行即可：全局 sessionStorage 已在每次调用前切换。
await import(pathToFileURL(outfile).href)

rmSync(outfile, { force: true })
