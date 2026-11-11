// tsc compiles only TypeScript, but the server reads bundled JSON data at runtime.
// Copies src/defaults/*.json into dist/src/defaults/ after `npm run build`.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'

const from = path.join('src', 'defaults')
const to = path.join('dist', 'src', 'defaults')
mkdirSync(to, { recursive: true })

const files = readdirSync(from).filter((f) => f.endsWith('.json'))
for (const f of files) copyFileSync(path.join(from, f), path.join(to, f))
console.log(`Copied ${files.length} data file(s) to ${to}`)
