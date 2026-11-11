# Experiments

Measurements behind the memory pipeline's design. Each used a copy of a real, long saved story as
the test input, because a scene that already failed in practice has a known ground truth, and a
synthetic scene tends to be accidentally easy. Runs were serial (one model at a time) and used
several trials per arm, since output at temperature ~1 varies too much for a single trial to mean
anything.

The harnesses that remain are `scripts/story-to-date-verify-ab.ts`,
`scripts/story-to-date-fold-tuning-ab.ts` and `scripts/evaluate-worker-models.ts`. They need a
saved story and provider credentials, so they are not part of the test suite.

## 1. Coverage skipping, and the bounded input window

**Problem.** Every recap ends with a self-reported coverage number. A job given a 60-post backlog
summarized only the last scene but reported coverage 56 posts past the previous recap. The skipped
scenes were absent from the recap and also dropped from the verbatim tail, so they vanished from
the prompt. Every existing check looked only at the claim's end (ceiling, seam, words per post), and
a long enough block (236 words over 56 posts, 4.2 words per post) passed all of them.

**Fix.** Bound what the model can see. A continues job's input is limited to the next N visible
posts after prior coverage, so it cannot claim coverage over posts it never saw.

**Tuning N.** The seam gate (coverage equals the input ceiling) fired on 8 of 8 scored trials: the
model ran coverage to the end of its input regardless of the instruction to stop at the first scene
break. The window therefore sets the scene size, not the prompt.

| Window | Words of memory per covered post (dense scene) | Result                |
| -----: | ---------------------------------------------: | --------------------- |
|     24 |                                       ~4 to 11 | Dense scenes overflow |
|     12 |                                      ~15 to 20 | Stays scene-scoped    |

Chosen: **12 posts**, with the maximum claimable advance lowered from 70 to 32 and then to 20.

## 2. A judge as detector, not as repairer

An LLM judge compares a recap with the verbatim posts it claims to cover and lists consequential
events the recap omits.

| Arm                             | Calls per trial | Outcome                                        |
| ------------------------------- | --------------: | ---------------------------------------------- |
| A: production flow              |               1 | 1 to 7 omissions per block                     |
| B: A plus judge and one rewrite |            ~1.7 | 0 of 3 passed; 4 to 8 omissions, longer blocks |

- The judge's omission lists were real when checked by hand, and it reliably flagged blocks whose
  coverage claim outran their content.
- Asked to add the missing events or roll coverage back, the model wrote longer blocks and still
  failed. Dense stretches saturate a one-scene block: about 200 to 380 words cannot hold 20 or more
  posts of consequential events. The lever is narrower coverage, not longer blocks.
- The judge is noisy: occasional pass verdicts with a listed omission, and varying counts across
  identical trials. A majority vote of three (flag at two) reduces this.

**Decision.** The audit ships as a manual, detector-only tool. It records a flag and the missing
lines on the segment, and never edits or gates anything.

**Which model runs it.** The same judge was run by the Editor model and by the small Worker model
(8B parameters) on four recent segments.

|              | Flagged | Agreement with Editor | Median latency |
| ------------ | ------: | --------------------: | -------------: |
| Editor model |     2/4 |                     - |           8.0s |
| Worker model |     4/4 |                   2/4 |           9.7s |

The Worker defaulted to "fail". It reported events as missing that were present verbatim, flagged
staging its own rubric excludes, misread who proposed what, and leaked template tokens. An audit
that cries wolf on clean segments is worse than none, so the audit stays on the Editor.

A fast, cheaper model (about 4x faster) was also tried as the Editor and rejected: 2 of 3 trials
produced no parseable output, and the one that did invented details and described posts beyond its
claimed coverage.

## 3. Fold compression: ratio and ceiling

Folding condenses old recaps into a deep-past digest. Folds were coming out barely shorter than
their input.

**Cause.** The model was obeying the prompt. Observed output was about 34% of input, almost exactly
the 0.5 word-count ratio it had been told to hit. The target was not aggressive enough, and nothing
tied the API's `max_tokens` to that target.

Two levers were tested on one real batch (1,044 words, about 1,640 tokens):

| Arm                          | Ratio | Ceiling sent | Target words | Output words | Output / input |
| ---------------------------- | ----: | -----------: | -----------: | -----------: | -------------: |
| a: baseline                  |   0.5 |  4096 (full) |          522 |          701 |          68.3% |
| b: tighter ratio             |   0.2 |  4096 (full) |          209 |          313 |          30.9% |
| c: tight ceiling             |   0.5 |  1018 (1.3x) |          522 |          560 |          57.2% |
| d: both                      |   0.2 |   409 (1.3x) |          209 |          260 |          25.4% |
| e: ratio 0.1, 200-word floor |   0.1 |  4096 (full) |          200 |          248 |          24.6% |
| e2: ratio 0.1, floor lowered |   0.1 |  4096 (full) |          104 |          176 |          17.7% |

- No arm ever reached its ceiling (all ended with `finish_reason: stop`), so this batch could not
  prove the ceiling's value. An earlier unconstrained fold that wrote 2.7x its target shows
  overshoot does happen.
- A 200-word floor on the target silently masked ratio 0.1 (arm e looked like ratio 0.2).
- Quality was checked fact by fact. Ratio 0.2 kept every load-bearing fact across two samples and
  dropped only scene color. Ratio 0.1 introduced a wrong attribution and dropped a recurring
  character trait.

**Decision.** Ratio 0.2, and a per-call token ceiling of 1.3x the target (never above the model's
limit). Truncation checks compare against that ceiling.

## 4. Choosing an Editor model

Triggered by a real quality problem: a lighter model dropped load-bearing detail from recaps (an
important glance and the cause of an injury), leaving vague labels with no antecedent.

**Method**

1. Test on a real scene that already failed, not a synthetic prompt.
2. Confirm in the raw log that the dropped details are inside the claimed window. If they are not,
   the fix is windowing, not the model.
3. Use one harness where every variable (guidance text, sampler, scaffold, model) is an arm in the
   same table, so results stay comparable.
4. Score with a direct check for known facts in the final text as well as an LLM judge. A judge
   inherits the severity of whichever model runs it, so a stricter judge makes a better output look
   worse. Pin the judge to one fixed model for every arm.
5. Use 5 to 10 trials per arm before believing a difference.

**Results**

- Guidance wording and temperature (0.3, 0.6, 1.0) did not converge; noise between arms was often
  larger than the effect.
- **Scaffolding helped.** Asking the model to list consequential events first, then write the
  recap in the same call, raised detail retention for a lightweight model from about 46% to 87.5%.
  Extraction and compression appear to be different loads.
- **Model choice was the largest lever.** The strongest candidates retained 80 to 100% of the key
  details with no tuning, and the best of them was also faster. Mid-size 70B models showed no edge
  over a scaffolded small model while costing more concurrency.

**Infrastructure lessons for any comparison round**

- Killing a local task does not cancel a provider-side request. It keeps holding its concurrency
  slot until it finishes, so an immediate retry stacks a second reservation and gets rate limited.
  Check the live concurrency feed first.
- Run one model at a time; per-model cost varies and two large models exceed the plan limit.
- Separate failure causes, because each needs a different response: gated behind a license,
  a reproducible formatting bug (one model dropped the leading `[` of the tag on 10 of 10 runs,
  which is trivially repairable), genuinely slow inference (confirmed with a bare streaming probe
  that logged per-chunk timestamps, not assumed), not yet released, or temporarily busy.

## 5. Provider response shapes

How models emit reasoning (a separate field, inline tags, or nothing) and which request options
control it varies by model and provider, and it changed under the app more than once. The format
probe and its runtime drift check are described in [providers/](providers/).
