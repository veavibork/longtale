# Featherless filter tags

The values behind the model-search filters on featherless.ai, harvested by hand on 2026-07-01. The
public API has no facets endpoint, and `/v1/models` does not echo a model's tags, but it does accept
them as query filters.

## Reliability

These are not an official taxonomy. `capabilities`, `domains`, `creative` and `training` are almost
certainly Hugging Face's free-form, self-reported model-card `tags`: arbitrary strings, no
validation. `families`, `architectures`, `parameter_bucket` and `modalities` look computed from the
model config, but that is inference. Treat everything as a soft signal, `creative` especially.

## Ratings

`src/defaults/featherless-tag-ratings.json` holds all 449 values with:

- `filter`: `always`, `never` or `neutral`.
- `worker`, `editor`, `author`: 0-5 usefulness when choosing a model for that role (default 3).
- an optional `note`.

Only 7 values are hard `always` or `never`, and all are structural: `modalities=text` is required;
`modalities=embedding`, `capabilities=image-generation` and `video-generation`, and
`families=bert`, `nomic-bert` and `xlm-roberta` are excluded. Everything else is a soft rating.

The JSON is generated. Edit the overrides in `scripts/generate-tag-ratings.ts` and rerun it.

## Use in the app

`src/inference/featherless-tag-ratings.ts` exposes the query helpers, and `suggestFiltersForRole(role)`
in `src/inference/featherless-models.ts` builds a starting `listModels` filter for a role. Because
the list response does not echo tags, ratings only bias the search query. They cannot score a model
that has already been fetched.

## Findings

- `capabilities=tool-use` only loosely predicts real tool-calling ability. The agents no longer use
  tool calls, so it is rated neutral for Worker and Editor; verify empirically if that changes.
- Several values in one dimension combine as OR. `creative=a,b` and `creative=a&creative=b` both
  return the union (for example 51 and 564 results alone, 567 combined).
- `per_page=500` does not return 500 results even when `total` is higher, so do not rely on
  `per_page` for exact counts.
