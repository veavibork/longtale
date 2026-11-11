import type { Context } from 'hono'

/** Formats Zod validation errors into the `{ error: string }` shape the frontend (`web/src/api/client.ts`) expects. */
export const validationHook = (
  result: {
    success: boolean
    error?: readonly {
      path?: readonly (string | number | symbol | { readonly key: string | number | symbol })[]
      message: string
    }[]
  },
  c: Context,
): Response | void => {
  if (result.success) return // let handler proceed
  if (result.error?.length) {
    const msg = result.error
      .map(
        (i) =>
          `${i.path?.map((p) => (typeof p === 'object' ? p.key : p)).join('.') || '(root)'}: ${i.message}`,
      )
      .join('; ')
    return c.json({ error: msg }, 400)
  }
  return c.json({ error: 'validation failed' }, 400)
}
