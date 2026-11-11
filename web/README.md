# Longtale — Frontend

React 19 + Vite 8 single-page application for Longtale, a collaborative storytelling app. Connects
to the Hono backend via Vite's dev proxy (`/api` → `http://localhost:4113`).

## Quick start

From this directory:

```bash
npm install
npm run dev        # Vite dev server; backend must also be running (npm run dev from repo root)
npm run build      # type-check + production build
npm run lint       # oxlint
```

## Key views

| View             | File                  | Purpose                                               |
| ---------------- | --------------------- | ----------------------------------------------------- |
| Story            | `StoryPanel.tsx`      | Chat, post controls, IC/OOC toggle, streaming replies |
| Worldbook        | `WorldbookView.tsx`   | CONTENT/ROSTER/MEMORY entry management                |
| Segments         | `SegmentsView.tsx`    | Story-to-date segment management                      |
| Context          | `ContextView.tsx`     | Assembled prompt inspector                            |
| Config > Queue   | `QueueView.tsx`       | Live job queue and concurrency slots                  |
| Config > Logs    | `LogsView.tsx`        | Per-post generation telemetry                         |
| Config > Agents  | `AgentsView.tsx`      | Provider keys, model/param selection, fallback chains |
| Config > Prompts | `PromptsView.tsx`     | Read-only prompt/tool-schema template library browser |
| Settings         | `PreferencesView.tsx` | Layout JSON, phrases to avoid, CSS, play-tab prefs    |
| Saves            | `SavesView.tsx`       | Story/fork management                                 |

Names are the default layout's menus; layouts are editable per user. See
`src/components/Registry.tsx` for the authoritative tab-id → component mapping.

## Conventions

- One `.css` file per view/component — no CSS framework
- Server state via TanStack Query (`hooks/`), client state via Zustand with `persist` middleware
  (`store.ts`), plus `apiFetch` (`api/client.ts`) for the underlying requests
- `lib/api-limiter.ts` bounds concurrent in-flight request throughput
- Touch-first; must work on Android and Windows browsers
- Config-driven layout via `Nav.tsx` + `components/Registry.tsx`
- Build-info header (`__BUILD_INFO__`) stamped at `vite build` time for deploy verification
