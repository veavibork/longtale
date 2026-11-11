# Development

Setup and commands are in the [README](../README.md). This page covers how the code is organized and
the conventions it follows.

## Layout

```text
src/            backend
  index.ts      Hono app, middleware, startup, shutdown
  routes/       HTTP handlers (stories/ is a sub-router mounted under /api/stories)
  services/     business logic: memory pipeline, worldbook, history, fork, layout
  queue/        job runner, slots, concurrency feed, executors, SSE events
  inference/    Featherless and Horde clients, reasoning-stream splitting, format probe
  db/           schemas and one store per entity
  middleware/   session guard
  lib/          crypto, credential rules, errors, login throttle, time, uuid
  defaults/     bundled data (model tag ratings, default global CSS)
web/src/        frontend: views, components, hooks, api modules, Zustand store
scripts/        maintenance tools and experiment harnesses
tests/          Vitest suites (db, lib, services)
e2e/            Playwright specs
docs/           documentation
```

## Data

- `data/global.sqlite`: users, sessions, model configs, settings, layouts, format profiles.
- `data/stories/<id>.sqlite`: one file per story. Open with `getStoryDb(id)`; close with
  `closeStoryDb(id)` when a short-lived caller is done.
- `LONGTALE_DATA_DIR` moves the whole data folder. Paths are resolved at call time, so tests and
  tools can redirect them.
- To reset local data, stop the server and delete `data/`.

Conventions:

- Schemas are created from `global-schema.ts` and `story-schema.ts` when a database is opened.
  There is no migration layer; the schema files describe the current shape. If you change a table,
  update the schema file and recreate local data.
- Every connection sets WAL, foreign keys on and a 5 s busy timeout.
- One `*-store.ts` per entity. Stores take a database handle and never open connections.
- Row ids are UUIDv7 from `src/lib/uuid.ts`; never sequential integers.
- Read-only tools opening a story database pass `{ skipRecovery: true }`, so they do not reset
  jobs that a running server is executing.
- Scope every query on per-user data by user id in SQL. See
  [engineering-notes.md](engineering-notes.md).

## Backend conventions

- Validate request bodies and params with Zod through `sValidator` and `validationHook`.
- Story routes are covered by one ownership middleware; do not repeat the check per handler.
- Executors own their whole lifecycle: begin, run, finish or fail, and release slot and abort
  controller in `finally`. Rethrow cancellation before retry logic.
- Multi-step writes that must be atomic go in `db.transaction`.
- Prompts live in `src/prompts.ts`, except the memory-pipeline prompts in
  `services/story-to-date/engine.ts` and `audit.ts`. The Prompts tab lists them all from
  `services/prompt-catalog.ts`.

## Frontend conventions

- One `.css` file per view or component, plain CSS, custom properties for theming (`index.css`).
- Server state: TanStack Query. Client preferences: Zustand with `persist`, one `longtale.ui`
  key. Story streaming: a reducer in `StoryViewReducer.ts`.
- Components are `PascalCase`, hooks start with `use`, utilities are `kebab-case`.
- Touch-first: pointer handlers, not mouse-only ones.
- API modules in `web/src/api/` are one per resource, over a shared `apiFetch` that adds the
  session header.

## Testing

| Command                 | What it runs                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `npm test`              | Vitest: store tests, pure logic, services, a pipeline smoke test |
| `npm run test:coverage` | The same with coverage                                           |
| `npm run test:e2e`      | Playwright: API critical path and a browser login                |

Unit tests use in-memory databases (`tests/db/helpers.ts`) or a temporary data folder. The e2e run
starts both dev servers against its own data folder (`e2e/.data`) with the session guard bypass
enabled; it never touches `data/`. The bypass (`DEV_BYPASS_SESSION_GUARD=true`) is honoured only
when `NODE_ENV` is `development` or `test`, and the Playwright config sets both. Browsers install
with `npx playwright install chromium`.

Nothing in the suite calls a model provider.

## Checks before committing

```bash
npm run typecheck && npm run lint && npm test
cd web && npx tsc -b --noEmit && npm run lint
```

`npm run format` runs Prettier. A pre-commit hook formats staged files.

## Scripts

| Script                            | Purpose                                                   |
| --------------------------------- | --------------------------------------------------------- |
| `init-db.ts`, `create-user.ts`    | Create the databases and a user                           |
| `generate-tag-ratings.ts`         | Regenerate `src/defaults/featherless-tag-ratings.json`    |
| `sync-hf-model-tags.ts`           | Refresh the cached Hugging Face model tags                |
| `evaluate-worker-models.ts`       | Rank candidate Worker models from the Featherless catalog |
| `format-probe.ts`                 | Probe a model's reasoning and prefill behaviour           |
| `story-to-date-verify-ab.ts`      | Judge and rewrite experiment (see experiments.md)         |
| `story-to-date-fold-tuning-ab.ts` | Fold ratio and ceiling experiment                         |
| `provider-checks/`                | Raw `curl` probes of provider behaviour (see its README)  |

The provider scripts need a key in the environment (for example `FEATHERLESS_API_KEY`). The
experiment scripts read a saved story from `LONGTALE_DATA_DIR`.

## Diagnostics

With a story open, these show what the memory pipeline is doing:

```text
GET  /api/stories/:id/context/summary
GET  /api/stories/:id/context/manifest
GET  /api/stories/:id/prompt-preview
GET  /api/stories/:id/story-to-date
POST /api/stories/:id/context/backfill   {"enqueueJobs": true}
POST /api/stories/:id/context/enqueue
```

The Queue tab shows what holds each provider slot, and the Context tab shows the assembled prompt.
Outbound model requests are logged to `data/outbound-requests.log` (recent entries only, and it
contains prompt text).
