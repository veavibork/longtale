# Featherless API notes

Featherless's published documentation does not always match live behaviour. This page records what
was confirmed against the real API in July and August 2026, so it does not have to be rediscovered.
Re-test before relying on any of it, because the service changes.

## Requests

Node's default `fetch` User-Agent is silently blocked by the provider's WAF, which answers
`404 Not Found` with body `Gone.` instead of a `403`. Any non-empty custom `User-Agent` fixes it.
All requests set one (`FEATHERLESS_USER_AGENT`).

## Model catalog

`GET /v1/models` returns, per model: `id`, `is_gated`, `context_length`, `max_completion_tokens`
(sometimes absent), `concurrency_cost`, `features.tool_use` and `available_on_current_plan`.

- `features.tool_use` is the real tool-support flag, nested under `features`. There is no top-level
  capabilities list.
- `concurrency_cost` is a real per-model field. Read it from the catalog instead of hardcoding slot
  costs; the app refreshes stored costs when the model list is fetched.
- `?capabilities=chat,tool-use` filters server-side (434 results against about 22,000 unfiltered)
  but is approximate: about 5% of results lack `features.tool_use`. Use it to shrink the payload and
  verify client-side.
- `q` is a fuzzy search, not a lookup. `getModel(id)` searches and then matches the id exactly.

## Tool calling

- **`tool_use: true` does not mean reliable forced tool calls.** A community fine-tune listed with
  the flag failed to call a forced tool in 0 of 14 attempts. The cause was not isolated. The flag
  reflects architecture support, not per-fine-tune reliability, so verify empirically.
- **Parallel calls can return `tool_calls[].id: null`.** With four calls in one turn, some entries
  had no id, and sending them back produced `422 Expected string, received null`. A missing id now
  gets a synthetic one client-side. Single forced calls were unaffected.

## Errors and fallback

| Code | Meaning                                         | Handling                             |
| ---: | ----------------------------------------------- | ------------------------------------ |
|  400 | Model cold, not loaded yet (minutes to an hour) | Next model in the fallback list      |
|  401 | Bad or missing key                              | Fatal                                |
|  403 | Model gated, needs unlocking on the site        | Next model                           |
|  404 | Model id does not exist (undocumented)          | Next model                           |
|  500 | Provider-side failure                           | Retry on the same model with backoff |
|  503 | Insufficient capacity                           | Retry with backoff, then next model  |

The same-model backoff delays are 5 s and 15 s. Network errors and empty replies fail immediately,
since another model would not help.

## Concurrency

`GET /account/concurrency/stream` (server-sent events, no `/v1` prefix) reports `limit`,
`used_cost`, `request_count` and a `requests[]` list (id, cost, model, start, duration) for the whole
account. It is the authority for slot availability. A local counter drifts from reality, for
example when another process uses the same key.

**Aborting a stream client-side does not cancel it server-side.** A streaming request was killed
after 2 seconds and still showed in the feed, with its duration climbing, for more than 21 seconds,
holding its slot the whole time. Aborts stop the app from waiting and free its local reservation,
but not the provider's slot. This is why the live feed is primary and local reservations only
cover the gap until the feed catches up. After killing a run, check the feed before retrying, or a
second reservation stacks on the orphan and is rate limited.

## Token-level control

- `/v1/tokenize` accepts `{model, text}` and returns only `{count, model}`. No token ids, whatever
  flags are sent.
- **`logit_bias` is honoured**, at least on some models. A first test (banning token ids 0 to
  49,999 at maximum strength) showed no effect and led to the conclusion that nothing could be
  controlled. A later re-test showed the opposite. On a plain completions endpoint, banning a token
  changed output and forcing one produced a repeating loop. On the chat endpoint with the same wide
  ban, the model routed around the banned English tokens and switched to Chinese. The first test's
  model was not recorded, so whether it was model-specific or simply wrong is unresolved. Do not
  treat "no token-level control" as established.
- **Suppressing one word needs every token spelling of it.** Tested with a placeholder name and the
  model's real tokenizer:

  | Bias applied                                                       | Output                                            |
  | ------------------------------------------------------------------ | ------------------------------------------------- |
  | none                                                               | "Kit slaps **Mara** with a fish"                  |
  | ban only the fused `" Mara"` token                                 | model reroutes through a newline; the word stays  |
  | ban the fused token and the tail shared by every spelling          | model substitutes a similar real word             |
  | ban all five variants (fused, split, lowercase, each with a space) | "Kit slaps **Mia** with a fish", with no breakage |

  Broad coverage makes the model paraphrase around the word; banning a huge swath of the
  vocabulary degrades it into repetition.

- **Not implemented.** Doing this for real needs a pure-JS tokenizer loaded from each model's
  published `tokenizer.json`, a cache of word to token-id sets per model, and a defined fallback for
  models whose tokenizer is not public (some models' repositories did not resolve). The app's
  "phrases to avoid" list is therefore a prompt instruction only.

## Streaming and reasoning

- On DeepSeek V4-Pro, reasoning arrives in `delta.reasoning` and the answer in `delta.content`,
  never tag-wrapped. A parser must also accept `delta.reasoning_content` and ignore `reasoning: null`
  on the final chunk. Without a prefill the model sometimes skips reasoning entirely.
- `chat_template_kwargs` carries per-model switches such as `enable_thinking`. Keys are
  family-specific and not interchangeable, so the client sends both `enable_thinking` and
  `thinking` rather than trusting one name.
- Models differ in how they expose reasoning and in which request options control it. See
  [reasoning-and-format.md](reasoning-and-format.md).
