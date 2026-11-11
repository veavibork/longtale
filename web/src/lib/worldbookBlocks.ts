// Same pattern as src/services/worldbook/extraction.ts, used to highlight worldbook blocks in chat
// exactly where the backend will extract them. Backend and frontend share no module; keep both in sync.
export const WORLDBOOK_BLOCK_PATTERN = /\[(CONTENT|ROSTER|MEMORY)\]([\s\S]*?)\[\/\1\]/g
