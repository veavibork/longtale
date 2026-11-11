# Longtale

A web app for long-form collaborative storytelling that stays coherent long after the story stops
fitting in the model's context window.

Language models forget. Past a few thousand tokens of play, characters contradict established
facts, drop threads and repeat themselves, and naive truncation makes it worse. Longtale keeps a
story consistent by replacing old history with model-written recaps, validating those recaps before
accepting them, and keeping a bounded amount of memory no matter how long the story runs.

In practice, stories stayed consistent past 400,000 tokens on models limited to a 32k context
window, without relying on tool calling, which providers support unevenly.

## How it works

- **Rolling memory.** When the prompt reaches 80% of the usable context, an Editor model summarizes
  the oldest unsummarized scene into a recap. Recaps, a small shared worldbook, and the most recent
  posts are what the Author sees.
- **Validated, not trusted.** Each recap claims how far it covers. The claim is checked against the
  input window, rejected if it skips scenes, runs to a mid-scene cut, duplicates the previous recap,
  or is too thin for the span it claims, and retried or repaired where possible.
- **Bounded size.** Old recaps fold into shorter digests, so memory stays small however long the
  story gets.
- **Edit-safe.** Editing, retrying, undoing or forking over a post drops exactly the recaps that
  covered it.
- **Measured.** Window size, fold ratio and the audit design came from experiments on real long
  stories. See [docs/experiments.md](docs/experiments.md).

Around that core: a server-side job queue with provider-aware concurrency, two inference providers
(Featherless and AI Horde) with ranked model fallback, streaming with reasoning-trace handling,
per-story SQLite databases, branching, undo and redo, per-user model configuration, and a
touch-first React interface with a configurable layout.

## Quick start

Requires Node.js 22 or newer.

```bash
npm install
cd web && npm install && cd ..
cp .env.example .env        # set APP_MASTER_KEY (command in the file)
npm run db:init
npm run user:create -- <name> <password>   # password: 8 to 72 characters
```

Run the backend and the frontend in two terminals:

```bash
npm run dev                 # backend, http://127.0.0.1:4113
cd web && npm run dev       # frontend, http://localhost:5173 (proxies /api)
```

Open the frontend, log in, and set a provider key under Config > Agents. The AI Horde works with
its anonymous key; Featherless needs an account key.

To start over, stop the server and delete `data/`.

## Commands

| Command                   | What it does                        |
| ------------------------- | ----------------------------------- |
| `npm run dev`             | Backend with reload                 |
| `npm run build`           | Compile the backend to `dist/`      |
| `npm start`               | Run the built backend               |
| `npm run typecheck`       | Type-check the backend              |
| `npm run lint`            | Lint with oxlint                    |
| `npm run format`          | Format with Prettier                |
| `npm test`                | Unit and integration tests (Vitest) |
| `npm run test:e2e`        | API and browser tests (Playwright)  |
| `cd web && npm run dev`   | Frontend dev server                 |
| `cd web && npm run build` | Type-check and build the frontend   |

Before the first `npm run test:e2e`, install its browser once with
`npx playwright install chromium`.

The built backend (`npm start`) serves only the API. To run a build, serve `web/dist` with any
static file server or reverse proxy that forwards `/api` to the backend on port 4113.

## Documentation

- [Architecture](docs/architecture.md): components, memory pipeline, queue, providers, data,
  security model.
- [Experiments](docs/experiments.md): the measurements behind the design.
- [Engineering notes](docs/engineering-notes.md): recurring defect classes and how they were fixed.
- [Development](docs/development.md): code layout, conventions, testing.
- [Provider notes](docs/providers/): observed behaviour of the provider APIs.

## Status and limits

- The test suite (about 270 unit and integration tests, plus Playwright API and browser tests)
  does not call any model provider. The provider integrations were developed against the live APIs;
  their observed behaviour is written up in [docs/providers/](docs/providers/).
- The per-user "phrases to avoid" list is added to the prompt as an instruction, so it reduces
  unwanted phrasing but cannot guarantee it. Token-level suppression (`logit_bias`) works on some
  Featherless models, but it needs each model's tokenizer ids, which the API does not expose. The
  experiment and the design for doing it properly are in
  [docs/providers/featherless-notes.md](docs/providers/featherless-notes.md).
- The AI Horde cannot stream, so its replies arrive whole, and a submitted request cannot be
  cancelled.
- **Security.** Longtale is built for a small group of trusted users on a private network. It has
  throttled login, one active session per user with a 30-day idle timeout, encrypted provider
  keys, per-user data isolation and validated input, and binds to loopback by default. It does not
  encrypt story content at rest and has no account-recovery flow. The full list is in the
  [security model](docs/architecture.md#security-model). Do not expose it to the open internet
  as is.

## License

MIT. See [LICENSE](LICENSE).
