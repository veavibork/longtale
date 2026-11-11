# Architecture

Longtale is a private web app for long-form collaborative storytelling with a language model. Its
central problem is keeping a story coherent after it no longer fits in the model's context window.

## Design goals

- **Long-context coherence.** Characters and facts must survive a story many times longer than the
  context window, without hard truncation.
- **Provider independence.** Model choice, fallbacks and limits are per-user configuration, not
  code.
- **Predictable inputs.** One small, shared schema for world knowledge, so prompts and tooling
  stay uniform.
- **Small and inspectable.** SQLite, one process, no external services beyond the model provider.

## Components

| Part     | Technology                                                                             |
| -------- | -------------------------------------------------------------------------------------- |
| Backend  | Node.js, TypeScript (ESM), Hono, `better-sqlite3`, Zod                                 |
| Frontend | React 19, Vite, TanStack Query, Zustand, `react-virtuoso`                              |
| Storage  | One global SQLite file (users, settings, model configs) plus one SQLite file per story |
| Models   | Featherless (OpenAI-compatible, streaming) and AI Horde (submit and poll)              |
| Tests    | Vitest (unit and integration), Playwright (API and browser), oxlint, Prettier          |

Per-story files isolate stories from each other, avoid a single shared write lock, and make
delete, fork and export file operations.

## Agents

Three roles, each assigned to a model through user configuration:

- **Author** writes the story. It treats player input as the player character's actions, not as
  commands, and narrates everything else.
- **Editor** talks through setup and updates with the user, and produces the memory recaps.
- **Worker** does small background jobs, such as scene titles.

## World knowledge

Worldbook entries are plain prose wrapped in a bracket tag. The Editor writes them in normal
conversation and the backend extracts them with a regular expression. There is no model-side tool
call. An earlier design used typed schemas filled through tool calls; tool-call reliability, not the
schema, was the weak point.

```text
[CONTENT]   setting, premise, register, what is welcome and what is off the table
[ROSTER]    one character, group, creature or place
[MEMORY]    a durable fact, promise or event
```

Every visible entry is included in every Author prompt, in creation order. The `Register:` line of
the content entry sets the tone that prompts and recaps are told to match.

## Story flow

1. **Setup.** The user talks to the Editor. Tagged spans become worldbook entries, shown live
   beside the chat.
2. **Kickoff.** The Author writes an opening post from the worldbook alone. Feedback acts as a
   guided retry. The user can return to setup or approve; setup posts are then hidden, not deleted.
3. **Story.** Each submit creates a queued job. User input never goes straight to a provider, which
   is what makes concurrency limits and cancellation manageable.

Controls: retry, guided retry, continue, guided continue, edit, undo and redo, and fork into a new
independent story from any post. Undo and redo move a cursor over the log and never delete
anything. The API can also rewind the cursor straight to any earlier post; the interface reaches it
only through undo.

Two toggles on the input bar set the reply length and the reasoning effort for the next generation,
and persist until changed. A per-user list of phrases to avoid is added to the final steering note
of every generation; it is a prompt instruction, not a guarantee.

## Memory pipeline

Older history is collapsed into Editor-written recaps; recent posts stay verbatim.

**Prompt assembly**, in order: Author system prompt, worldbook entries, one merged
`[STORY TO DATE]` block, then the verbatim posts after the last recap's coverage. The newest 16
posts are always verbatim, even when recaps cover them.

**Trigger.** When the assembled prompt reaches 80% of usable context (context limit minus response
reserve), an Editor job is queued.

**Segments.** The first job writes `[STORY BEGINS]`, later ones `[STORY CONTINUES]`. Each ends with
`[COVERAGE]N[/COVERAGE]`, the absolute post number it summarizes through.

**Bounded input window.** A continues job sees only the next 12 visible posts after prior
coverage and may not claim coverage into the verbatim tail. Because the model tends to run coverage
to the end of whatever it was given, the window is what actually limits a segment to one scene. A
backlog is worked off by chaining jobs.

**Quality gates**, each causing a retry or rejection:

- Coverage equal to the input ceiling suggests a mid-scene cut, so one step-back retry is made.
- A sprint check rejects blocks that claim more than 20 posts, or at least 15 posts at under 2.5
  words per post.
- Blocks with 85% or more word overlap with the previous segment are rejected as duplicates.
- Coverage must land on a visible post inside the supplied window and must advance.
- Echoed markers are stripped, trailing meta-notes about the coverage ceiling are removed, and
  blocks ending on an action still unfolding are rejected.
- A missing opening tag, with otherwise clean prose and a valid coverage tag, is repaired.

Each job makes up to two attempts. Within an attempt, a coverage claim at the input ceiling and a
sprint each get one corrective follow-up call, so one job can make up to six Editor calls. A job
that cannot find any valid seam inside its window triggers a fold instead of retrying the same
window.

**Folding** keeps total memory bounded. When recaps exceed about 6,000 tokens, segments older than
the newest ~3,000 tokens are condensed into a `fold` row at about 20% of their length. If the fold
tier itself grows past that same ~3,000-token budget, it is condensed again. The replacement
happens in one transaction. A digest is discarded if the provider reports it was truncated or if
it fails to shrink.

**Invalidation.** Editing, retrying, undoing or forking over a post deletes every recap whose
coverage includes it, and their pending jobs. The trigger then rebuilds memory.

**Audit (manual).** A judge with three votes (flagged at two failures) checks a segment against the
verbatim posts it claims to cover and records missing events. It never edits or blocks anything; the
experiments showed it finds real omissions but is too noisy to act on automatically.

See [experiments.md](experiments.md) for the measurements behind these choices.

## Job queue

A single in-process runner scans every 500 ms. Jobs are rows in the story database, so a crash only
requires re-pending whatever was running.

| Priority | Job                                                                   |
| -------: | --------------------------------------------------------------------- |
|       10 | Interactive: prose, setup, setup worldbook pass, kickoff, retry, edit |
|        5 | `story-to-date` (recap)                                               |
|        4 | `story-to-date-fold`                                                  |
|        3 | `segment-audit`                                                       |
|        0 | `worldbook-compact`                                                   |
|       -1 | `segment-name`, `story-name` (Worker)                                 |

- Prose dispatches before background work. A prose job waits while a recap job is pending or
  running, and the client is told why.
- Editor memory jobs (recap, fold, audit) are limited to one at a time per user.
- Slots are gated on the provider's own account-wide concurrency feed plus local reservations for
  jobs just dispatched. If the feed is unhealthy, a fixed local cap applies.
- Every executor releases its slot and abort controller in a `finally`. A user's Stop aborts the
  in-flight call.
- Job progress and tokens are streamed to the browser over server-sent events, with a buffer so a
  reopened tab can reattach.

## Providers

- **Featherless** streams tokens. Transient 500 and 503 errors back off and retry on the same model.
  Statuses meaning the model is unavailable (400, 403, 404, 503) move to the next model in the
  user's ranked fallback list.
- **AI Horde** submits a request and polls it. There is no streaming and no account concurrency
  signal, so it has its own dispatch path with a local rate limit. A request that stays impossible
  for five minutes fails. A submitted request cannot be cancelled mid-flight.
- **Reasoning models.** Streams are split into reasoning and answer text, whether the provider
  sends a separate field or inline `<think>` tags. A per-model **format profile**, produced by a
  probe that tries request variants against the real endpoint, decides how thinking is enabled and
  whether to prefill. At runtime, a successful stream that contradicts the stored profile flags the
  model for a re-probe.

Provider code is isolated in `src/inference/`. The queue branches on provider at dispatch; a shared
adapter interface is a known gap. Research notes are in [providers/](providers/).

## Data

- **Global database:** users, sessions, per-user model configs and settings spaces, layout configs,
  format profiles, client error log. Encrypted provider keys live on the user row.
- **Story database:** `book` (the worldbook and logbook containers), `page` (a position in the
  log, with a selected text and fork), `text` (a version of a page), `story_to_date_segment`,
  `worldbook_entry`, `history_event` (undo stack), `story_state` (setup, kickoff or active phase)
  and `jobs`.
- A page holds many text versions. Retries add a version; editing adds one; the selected version is
  canonical.
- Row identifiers are UUIDv7; session tokens are random 256-bit values. Schemas are created from
  one definition on open; there is no migration layer.

## Frontend

A tabbed, touch-first layout configured as data (columns and tab buttons are stored per user, and
a registry maps tab ids to components). The default layout shows Story, Worldbook, Segments and
Context on the left, a Config menu (Queue, Logs, Agents, Prompts) in the middle, and Settings and
Saves on the right. The Context tab shows the exact prompt that would be sent, with each part's
source. The queue tab shows what holds
each slot and why a job is waiting.

Server state is TanStack Query; client preferences are persisted Zustand state; story streaming is a
reducer. A user-editable global stylesheet and named preference profiles customize appearance.

## Security model

Longtale is designed for a small group of trusted users on a private network, not for open
internet hosting. The protections below fit that boundary; the limits are stated deliberately.

**In place**

- Passwords are hashed with bcrypt. Login is rate-limited (five failures per fifteen minutes per
  name) and takes the same effort whether or not the name exists.
- One active session per user. A new login revokes the previous token, and the old client is told
  explicitly. A session expires after 30 days without foreground activity.
- Provider API keys are encrypted at rest with AES-256-GCM using a server-held master key, and are
  never returned to the browser except masked.
- Every story route sits behind one ownership check, and per-user data is filtered by user in SQL.
- All request bodies are schema-validated and limited to 2 MB, names, keys and identifiers have
  length limits, and all SQL is parameterized. Login, rename and user creation share one name and
  password rule.
- The server binds to loopback by default and sends no CORS headers, so other origins cannot read
  responses.
- The development auth bypass (`DEV_BYPASS_SESSION_GUARD`) is honoured only when `NODE_ENV` is
  `development` or `test`, so a server started without `NODE_ENV` always checks sessions.

**Not provided**

- Story content and logs are not encrypted at rest. Anyone with file access can read them.
- Users are created from the command line. There is no deletion or account-recovery flow.
- No audit log, two-factor authentication or per-address rate limiting. The login lockout is in
  memory and per name, so someone who can reach the server could lock a user out. Each login
  attempt also costs a bcrypt check on the main thread, so many attempts across many names can slow
  the server.
- A session has no absolute lifetime: it stays valid until logout, a new login or 30 idle days.
- Model format profiles are shared by all users, so anyone can see which models have been probed.
  Only the user who requested a probe can cancel it, because it runs on their provider key.
- Uncaught exceptions are logged and the process keeps running.

Hosting on the open internet would need at least TLS termination, content encryption, per-address
limits and a hardened session store.

## Out of scope

Image, audio and speech features; providers beyond Featherless and the Horde; a shared provider
adapter interface; drag-and-drop layout editing; consuming third-party tool servers.
