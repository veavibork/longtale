# Engineering notes

Recurring defect classes found while hardening Longtale, with the fix applied and how to avoid each
one. They come from a sliced correctness review of the whole codebase (40 findings: 6 high, 21
medium, 13 low, each independently verified) and from two later passes over the job queue and the
memory pipeline.

| Class                                        | Findings |
| -------------------------------------------- | -------: |
| State-machine guards                         |       10 |
| Error handling on async paths                |        9 |
| Correctness (logic, math, wiring)            |        6 |
| Races and concurrency                        |        4 |
| Resource leaks                               |        3 |
| Data loss or corruption                      |        4 |
| Authorization                                |        1 |
| Other (stale state, side effects, telemetry) |        3 |

## 1. Every async path needs a terminal state

Fire-and-forget work (`void fn()`) is safe only if every exit path records an outcome.

- A Horde job's completion branch had no `try/catch`. One thrown exception left the job `running`
  forever, and startup recovery deliberately skipped Horde jobs. Fix: catch, mark the job failed,
  stop polling.
- Several UI effects called `fetch().then(set)` with no `.catch`, which produced unhandled
  rejections and left state stuck at `null`. Fix: a catch on every promise that is not awaited.
- Prefer one wrapper per executor that owns the whole lifecycle: begin, run, finish or fail, release
  resources in `finally`.

## 2. Cancellation must not be swallowed by retry loops

A user's Stop is an error like any other until something decides otherwise. A retry loop with a
bare `catch` treats it as a failed attempt, tries again, and finally reports the job as failed.
This appeared in the naming executor and again, later, in the memory worker.

- Rethrow the cancel error (and anything raised while the abort signal is set) before applying
  retry logic.
- Optional refinement calls should fall back to the answer already in hand on ordinary failures, but
  still propagate cancellation.

## 3. Guard every state transition

- `finishJob` updated a row unconditionally, so a job that completed after being cancelled became
  `done` again. Fix: `WHERE status != 'cancelled'`.
- The "next segment" decision checked for an unfilled segment only on one branch. A failed first
  segment produced a duplicate `begins` segment and two queued jobs. Fix: check for an incomplete
  segment before choosing the kind, on every branch.
- `setActiveLayoutConfig` deactivated the user's configs before checking the target existed. Fix:
  validate first, then change state, in one transaction.
- Multi-step writes that must not be observed half-done belong in a transaction. The fold job
  deleted old segments and then created the replacement as separate writes; a crash in between lost
  that stretch of memory.

## 4. Invalidate when the content exists, not when the placeholder does

Retrying a post created an empty replacement and ran cache invalidation immediately. The
invalidation logic bailed out on the empty text, so summaries of the old content survived and were
fed back into the prompt. Fix: invalidate on the page, by position, independent of the new text.

## 5. Scope every query by owner at the data layer

`updateModelConfig` and `deleteModelConfig` took only an id, so any authenticated user could change
another user's configuration. A seeding routine read from a table keyed by role alone, so a second
user inherited the first user's models.

- Pass the owner into the store function and filter in SQL (`WHERE id = ? AND user_id = ?`), as the
  reorder function already did.
- Where a whole route family is owned by a parent resource, enforce ownership once in middleware.

## 6. Keep client state derived from what is displayed

- Reordering read the original list instead of the currently displayed order, so a second click
  undid the first.
- Render-time sync from a query overwrote an unsaved edit.
- An effect guarded by a ref that was never reset ran once per mount instead of once per story.
- A request header captured the session id before the request waited in a queue, so it could be
  sent with a stale one.
- Per-job accumulators keyed by page id (reasoning text) were never cleared, so a retry appended to
  the previous run.

Rules: derive from the displayed value, reset keyed state when the key changes, and read mutable
context at send time, not enqueue time.

## 7. Ephemeral maps leak unless every exit clears them

Per-job in-memory state (guidance, generation options, abort controllers, rate-limit timestamps)
was cleared when a job was dispatched but not when it was cancelled while pending. Fix: one
`clear...` function called from every terminal path.

## 8. Resource handling

- A database handle opened during setup was never closed if setup threw. Open, then `try/catch`
  around setup, closing on failure.
- The global database lacked a busy timeout, unlike the per-story databases.
- A polling loop looked jobs up in a list capped at the 30 most recent; with enough other jobs the
  one being watched fell out of the window. Look the job up by id.

## Defaults worth keeping

- Validate query parameters (`Number('abc')` is `NaN`; binding it to `LIMIT` throws).
- Validate request bodies with schemas that match the downstream expectation, not `z.unknown()`.
- Resolve paths and data directories when used, not at import, so tests and tools can redirect
  them.
- Test the failure path, not only the happy path: cancellation, a thrown completion step, a crash
  between two writes.

## Method

Reviewing by slice (queue, memory pipeline, routes, each frontend area) with an independent
verification pass for every finding kept noise low: each report had to name a concrete failure
scenario and survive an attempt to refute it. The later passes read the queue and memory pipeline
line by line, and exercised the real server against fresh databases rather than relying on unit
tests alone.
