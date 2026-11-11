# Raw API verification toolkit

Deterministic `curl` requests and a small server-sent-events parser for checking how an
OpenAI-compatible provider actually behaves (reasoning field name, tool-call integrity, effort
control) rather than relying on its documentation. The prompts in the request files are test
fixtures, each designed to force one specific behaviour. The app itself no longer uses tool calls;
the tool-call tests remain for evaluating providers and models.

## Quick start

```bash
KEY=your_featherless_key
API=https://api.featherless.ai/v1/chat/completions
# 1. Set the "model" field in the req-*.json files to the model under test
#    (they ship with moonshotai/Kimi-K2.7-Code).
# 2. Run a test and save the raw stream.
curl -sN --max-time 280 $API -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d @req-toolcall.json > stream1.txt
# 3. Analyze it.
python3 parse.py stream1.txt
```

`parse.py` rebuilds tool-call arguments from the streamed deltas and reports the finish reason,
the reasoning length and which field it arrived in, the tool-call ids (with duplicate detection),
and whether each call's arguments are valid JSON. Corruption shows up as invalid JSON or as tag
fragments inside argument values.

## Request fixtures

- **req-toolcall.json** asks for a ~100-line Python file written through one tool call. Long
  arguments maximize the chance of mid-stream corruption, "exactly once" removes ambiguity, and a
  fixed specification keeps runs comparable.
- **req-multitool.json** asks for two tool calls in one turn, the minimal reproduction for
  duplicate or missing tool-call ids.

## Test matrix

| Test                                        | Change from baseline              | Reveals                                                            |
| ------------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| long tool args                              | ~100-line file write              | mid-stream argument corruption or tag leakage                      |
| two tool calls, one turn                    | multitool prompt                  | tool-call id uniqueness                                            |
| `reasoning_effort: high/max/low`            | add param, non-stream             | which effort levels the host accepts                               |
| `thinking: {...}` vs nothing                | swap or remove param              | which thinking control works and which is silently ignored         |
| non-stream math question                    | no tools                          | which field carries reasoning (`reasoning` vs `reasoning_content`) |
| tool-result round trip, no reasoning replay | hand-built assistant+tool history | whether the endpoint validates replayed reasoning                  |
| forced `tool_choice` (named) + reasoning    | add both params                   | whether forced tool choice errors or conflicts with reasoning      |

## Method

- Run tests one at a time. Large models use several concurrency units, and parallel runs are
  rate limited (on a 429, wait about 45 seconds and retry).
- Do not conclude from a single run. A "feature does not work" finding needs at least two runs and
  a control condition.
- Keep every request and response file; they are the evidence.
- Change client configuration only after every test has passed twice.

## Caveats

- Providers change deployments without notice. Re-run after any announced backend change.
- Vendor documentation may describe a different deployment of the same model. For example, Z.AI's
  own API uses `reasoning_content`, while Featherless serves the same model with `reasoning`.
- A single empty-reasoning response once suggested reasoning was off; two runs plus a control
  showed it was on by default.
