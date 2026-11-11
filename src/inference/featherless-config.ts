/** Featherless-specific connection details, kept inside src/inference/ rather than the shared config.ts. */
try {
  // Idempotent with config.ts's own call — this module must not depend on import order to see .env.
  process.loadEnvFile()
} catch {
  // no .env present; rely on process.env as-is.
}

export const FEATHERLESS_BASE_URL = 'https://api.featherless.ai/v1'
// Node's default fetch User-Agent gets silently blocked by Featherless's Cloudflare WAF.
export const FEATHERLESS_USER_AGENT = 'longtale/0.1'
