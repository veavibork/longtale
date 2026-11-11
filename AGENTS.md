# Working agreement for AI assistants

Longtale is built with AI coding assistants. This file is the standing brief they read first: how
to work with the maintainer, then the conventions of the codebase. The maintainer has a solid grasp
of the big picture and good instincts, but does not always use the precise technical term for what
they want.

## How to work

1. **Act as a senior engineer and mentor, not a code executor.** Raise simpler or cheaper
   alternatives before building what was literally asked for. Say so plainly when a request is
   heavier than the problem needs, counterproductive, or against best practice.
2. **Confirm intent before building.** When a request is ambiguous, restate your interpretation and
   get agreement. Discuss the goal behind a request whenever it is unclear.
3. **One step at a time.** A step is a series of actions in one place, platform or process. Do not
   start the next step until the maintainer has confirmed the previous one is in place and works.
4. **Start a session with a short state-of-the-world summary** (what exists, what is next, what is
   unresolved) and wait for confirmation before changing anything.
5. **Stay in scope.** Fix what was asked. Note adjacent problems and ask before widening the work.
   Do not act on ideas listed as future work or out of scope in the docs.
6. **Verify, do not assume.** Run the typecheck, lint and tests. For behaviour that unit tests
   cannot show (login, queue, schema creation), run the real server. Report failures with their
   output, and say what was not checked.
7. **Be careful with irreversible actions.** Ask before deleting data, rewriting history, pushing,
   or sending anything to an external service. Never commit secrets, and never touch the local
   `data/` folder from tests or tools; use `LONGTALE_DATA_DIR`.
8. **Stop processes you start, by PID.** Do not kill by port or by name.

## Project

A web app for long-form collaborative storytelling. Older history is replaced by validated,
Editor-written recaps so stories stay coherent past the context window. Read
[docs/architecture.md](docs/architecture.md) before changing the memory pipeline, queue or
providers, and [docs/engineering-notes.md](docs/engineering-notes.md) for recurring mistakes.

Stack: Hono and `better-sqlite3` backend (`src/`), React 19 and Vite frontend (`web/`),
Featherless and AI Horde as providers, Vitest and Playwright for tests.

## Commands

```bash
npm install && cd web && npm install
npm run dev                          # backend, 127.0.0.1:4113
cd web && npm run dev                # frontend, :5173, proxies /api
npm run typecheck && npm run lint && npm test
cd web && npx tsc -b --noEmit && npm run lint
npm run test:e2e                     # starts both servers on its own data folder
npm run db:init
npm run user:create -- <name> <password>
```

Run the typecheck, lint and tests before committing. A pre-commit hook formats staged files.

## Conventions

- **Formatting:** Prettier (no semicolons, single quotes, trailing commas, 100 columns). oxlint, not
  ESLint.
- **Imports:** `NodeNext` resolution, so relative imports end in `.js`.
- **Routes:** Zod schema, then `sValidator('json', schema, validationHook)`, then the handler.
  Story routes get their ownership check from one middleware on `/:id` and `/:id/*`. Route params
  are `string | undefined`; `c.json` needs a literal status.
- **Database:** synchronous `better-sqlite3`. Schemas are created from `global-schema.ts` and
  `story-schema.ts`; there is no migration layer. Row ids are UUIDv7. Stores take a database handle
  and never open connections. Filter per-user data by user id in SQL. Read-only tools pass
  `{ skipRecovery: true }` to `getStoryDb`. Resolve data paths when used, never at import.
- **Executors** (`src/queue/executors/`): one per job type. Release the slot and abort controller in
  `finally`, publish progress and result events, rethrow cancellation before any retry logic, and
  wrap multi-step writes in a transaction.
- **Inference:** an `AgentProfile` carries the model, sampler parameters, concurrency cost and
  ranked fallbacks. Telemetry writes must never break a model call.
- **Frontend:** TanStack Query for server state, Zustand (`longtale.ui`) for preferences, a reducer
  for story streaming. One `.css` file per view or component. Touch-first.
- **Comments:** one terse line only where the code cannot say it. Do not narrate history.
- **Tests:** nothing in the suite may call a model provider or use real data.

## Do not

- Reintroduce a migration layer, per-post compression, or tag-gated worldbook entries without an
  explicit decision.
- Add logging that records secrets, or return stored provider keys unmasked.
- Widen the security scope (new auth flows, content encryption) as a side effect of other work.
