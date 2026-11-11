import { createHash } from 'node:crypto'
import type { TextRow } from '../../db/text-store.js'

/** Normalized gen_package fingerprint — same content must always produce the same stamp. */
export function computeTextContentStamp(text: TextRow | null): string | null {
  if (!text?.genPackage?.trim()) return null
  const normalized = text.genPackage
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return createHash('sha256').update(normalized).digest('hex')
}
