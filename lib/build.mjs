// dsh-surface — build: wrap src/client.js into a dsh module-loader bundle.
//   node lib/build.mjs   → writes lib/client.js
//
// Emulates the dsh UI-bundle contract (same shape dsh-worktree-panel uses):
// `window.__ModuleLoader__.load({ id, factory })`, where factory(require)
// resolves React + the dsh client service table via the module table. The host
// half (lib/index.js) is NOT bundled — it is loaded as source and imports
// @deepseek-ai/dsh-* by name, resolved by the running dsh host.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src', 'client.js')
const OUT = join(here, 'client.js')

const body = readFileSync(SRC, 'utf8')
const bundle = `window.__ModuleLoader__.load({\n\tid: "@lim324/dsh-surface",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n${body}\n\t\treturn module.exports;\n\t}\n});\n`

writeFileSync(OUT, bundle)
console.log(`built ${OUT} from ${SRC}`)
