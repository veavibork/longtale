# Reasoning streams and model format probing

Models that "think" expose it in different ways, and the request options that control it differ by
model family. Several bugs came from assuming one shape. This page records what was observed and
how the app now handles it.

## Three response shapes

A plain streaming call to each model with no `chat_template_kwargs`, logging every delta key:

| Shape                                                    | Observed on                         | Detectable from the stream |
| -------------------------------------------------------- | ----------------------------------- | -------------------------- |
| A. Separate `delta.reasoning` and `delta.content` fields | DeepSeek V4-Pro, Kimi K2.x, gpt-oss | Yes, by field presence     |
| B. `<think>...</think>` tags inline in `content`         | Qwen3                               | Yes, by tag parsing        |
| C. Reasoning as unmarked plain text in `content`         | GLM-4.7-Flash                       | No                         |

Some models (for example Gemma 4) produce no reasoning by default.

- **Shape C cannot be separated after the fact.** Only the request can prevent it:
  `chat_template_kwargs: {enable_thinking: false}` produced clean prose, while `thinking: false`
  (the key documented for DeepSeek-family models) had no effect. Keys are family-specific.
- A model can read as shape A and still fail to honour a disable switch: one Kimi variant kept
  emitting reasoning with either key set, though always in its own field.

## Bugs this caused

- **Routing by model name.** Reasoning was sent to the trace channel only for model ids matching
  `/deepseek/i`. A Kimi model has the same shape, did not match, and its reasoning text appeared in
  the visible reply. Routing is now by observed shape (field or tag presence), not by name.
- **Trusting the reasoning field when thinking is off.** With thinking disabled and no prefill,
  one model sometimes streamed answer text in `delta.reasoning`, so the client treated that channel
  as the answer. But the same channel also sometimes carried genuine planning text, plus, in 13 of 13
  affected stored replies, a stray leading token followed by degenerate, multilingual text. Treating
  `delta.reasoning` as safe to store as prose was wrong. The reasoning channel is untrusted when
  thinking is off.
- **Prefill and disable together.** With a thinking prefill and thinking disabled, the entire
  answer arrived in the reasoning field, which looked like an empty reply and caused retries.
  Prefill is now used only when thinking is explicitly on, and only for families that need it.
- **Default switches.** `enable_thinking` now defaults to false on the wire unless a caller sets it,
  because at least one family reasons in plain text when nothing is sent.
- A `thinking_budget` of 100 suppressed reasoning on a short prompt but hung on a production-size
  prompt (~18.7k tokens), so short-prompt probes can mislead.

Output at temperature 1 is not deterministic: the same configuration can skip reasoning in one run
and produce a long mixed-style trace in the next.

## The format probe

Hard-coding per-family rules did not scale, so the app measures each model.

1. **Hypothesis corpus** (`src/data/format-hypotheses.ts`): candidate thinking-tag markers,
   request keys, stop and end-of-text tokens that can leak, and model-name patterns, each with the
   evidence behind it.
2. **Probe engine** (`src/inference/format-probe.ts`): runs a matrix of request variants (thinking
   switch on, off, absent, with and without prefill) against the real endpoint, at least two runs
   per condition, and records the response shape, leaked tokens and a coherence check (length,
   word count, replacement characters). Validated against a model whose behaviour was already known.
3. **Profile storage.** A global table holds one profile per provider and model and doubles as the
   probe queue. Jobs are story-scoped, so a global probe cannot be one. A probe where every call
   failed is stored as failed, not as an authoritative "none observed" profile; the smoke test
   caught that bug.
4. **Consumers.** The profile decides whether to prefill, the idle-timeout length (a thinking
   model may be quiet for a long time, a non-thinking one should not be), which tags the stream
   splitter looks for, and the caveat shown on the effort control. Models without a profile fall
   back to name-based heuristics.
5. **Runtime tripwire.** After each successful stream, the observed shape is compared with the
   stored profile. It is one-sided: something appearing that the profile says should not flags the
   model, while silence never does. The first detection is kept, a successful re-probe clears it,
   and the Agents tab shows a flag. It does not re-probe automatically, because a probe holds
   concurrency slots.

The empty-completion retry rules stay shape-based, independent of the profile, as a safety net.
The probe is the map, shape-based routing is the safety net, and the tripwire detects when the map
has gone stale.

## Not done

- Raw completions endpoint with client-side chat templates, the only route to full control over
  prefill and thinking.
- A shared structure for every model family beyond the cases found so far.
