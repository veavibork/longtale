/** Sync HuggingFace model card tags for models we care about (Featherless catalog ids). */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { hfTagsPath } from '../src/inference/hf-model-tags.js'

// The same file the app reads, so a sync always lands where it is used.
const OUT_PATH = hfTagsPath()

const HF_API = 'https://huggingface.co/api/models'
const DELAY_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchTags(modelId: string): Promise<string[]> {
  const url = `${HF_API}/${encodeURIComponent(modelId)}`
  const res = await fetch(url, { headers: { 'User-Agent': 'longtale-tag-sync/1.0' } })
  if (!res.ok) {
    console.warn(`  skip ${modelId}: HTTP ${res.status}`)
    return []
  }
  const data = (await res.json()) as { tags?: string[]; cardData?: { tags?: string[] } }
  return data.tags ?? data.cardData?.tags ?? []
}

async function main() {
  const args = process.argv.slice(2)
  let modelIds = args
  if (modelIds.length === 0 && existsSync(OUT_PATH)) {
    const existing = JSON.parse(readFileSync(OUT_PATH, 'utf-8')) as Record<string, unknown>
    modelIds = Object.keys(existing)
  }
  if (modelIds.length === 0) {
    console.error('Pass model ids as arguments, or seed hf-model-tags.json first.')
    process.exit(1)
  }

  const out: Record<string, { tags: string[]; updatedAt: string }> = existsSync(OUT_PATH)
    ? (JSON.parse(readFileSync(OUT_PATH, 'utf-8')) as Record<
        string,
        { tags: string[]; updatedAt: string }
      >)
    : {}

  console.log(`Syncing ${modelIds.length} model(s) → ${hfTagsPath()}`)
  for (const id of modelIds) {
    const tags = await fetchTags(id)
    out[id] = { tags, updatedAt: new Date().toISOString() }
    console.log(`  ${id}: ${tags.length} tags`)
    await sleep(DELAY_MS)
  }

  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n')
  console.log('Done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
