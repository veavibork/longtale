/** Horde-specific connection details, kept isolated from config.ts the same way featherless-config.ts is. */
try {
  // Idempotent with config.ts's/featherless-config.ts's own calls.
  process.loadEnvFile()
} catch {
  // no .env present; rely on process.env as-is.
}

// Anonymous key is a valid, documented default for AI Horde.
export const HORDE_ANONYMOUS_KEY = '0000000000'
export const HORDE_BASE_URL = 'https://aihorde.net/api'
export const HORDE_USER_AGENT = 'longtale/0.1'
