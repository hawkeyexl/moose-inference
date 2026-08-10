---
status: "accepted"
date: 2026-08-10
decision-makers: [hawkeyexl]
consulted: []
informed: [docevals, dockg, agentevals, docmeta]
---

# Choose the local model tiers by measuring this library's own task, not by published benchmarks

## Context and Problem Statement

The `fast`/`balanced`/`quality` tiers were all unsloth Gemma 4 QAT builds, chosen on published
IFEval scores (94.6 / 96.7 / 97.2) and on the argument that one family keeps the chat template
identical across tiers. Neither of those is evidence about *this* library's task, which is
narrow and unusual: send a system prompt, a user prompt, and a JSON Schema, and get back JSON
that validates. Generation is grammar-constrained, so a model cannot emit malformed JSON no
matter how weak it is — which means IFEval, a test of following instructions in free text, is
measuring something the grammar already guarantees.

The gap showed up in a consumer. `docmeta` pinned `gemma-4-e2b-q2` for its CI, and that build
did not reliably terminate: it ran past two minutes on half the pages it was given. A catalog
whose smallest entry cannot finish a small job is not describing the models it ships.

## Decision Drivers

- Tier defaults are long-lived and are downloaded by `auto` on machines that never chose them.
- The failure that actually bites is non-termination, which no published benchmark reports.
- Weights are gigabytes; a tier that is larger for no measured gain is a real cost.
- Aliases are pinned by name in four consuming repos, so they cannot simply be deleted.

## Considered Options

- Keep the Gemma 4 tiers and re-rank them on published benchmarks
- Retier on a measurement of this library's own task
- Collapse the tiers to a single model, since measured quality barely varies with size

## Decision Outcome

Chosen option: **retier on a measurement of this library's own task**.

The benchmark: 26 real documentation pages had their `title` and `description` removed, were
refilled through this library under a JSON Schema, and the proposals were scored by token F1
against the human-written originals. Latency and non-termination were recorded per page.

| model | size | avg s/page | worst | combined | 95% CI |
|---|---|---|---|---|---|
| granite-4.1-3b UD-Q2_K_XL | 1.41 GB | 4.8 | 6s | 0.449 | [0.376, 0.521] |
| Qwen3.5-4B UD-Q4_K_XL | 2.91 GB | 6.7 | 8s | 0.453 | [0.388, 0.518] |
| gemma-4-e4b (old `balanced`) | 4.22 GB | 8.0 | 12s | 0.445 | [0.391, 0.500] |
| granite-4.1-8b UD-Q4_K_XL | 5.49 GB | 27.2 | **131s** | 0.457 | [0.391, 0.524] |
| Qwen3.5-9B UD-Q4_K_XL | 5.97 GB | 10.2 | 12s | **0.527** | [0.456, 0.599] |
| gemma-4-12b (old `quality`) | 6.72 GB | 11.1 | 13s | 0.499 | [0.411, 0.588] |

Resulting tiers, all Apache-2.0, each smaller and faster than what it replaces:

| tier | was | now | size change |
|---|---|---|---|
| `fast` | gemma-4-e2b (2.62 GB) | granite-4.1-3b-q2 (1.41 GB) | −46% |
| `balanced` | gemma-4-e4b (4.22 GB) | qwen3.5-4b (2.91 GB) | −31% |
| `quality` | gemma-4-12b (6.72 GB) | qwen3.5-9b (5.97 GB) | −11% |

Every superseded alias stays resolvable, untiered.

### Consequences

- Good, because each tier is smaller and faster, and `quality` is also better on the one task
  this library actually performs.
- Good, because two builds that do not reliably terminate are now excluded from selection and
  labelled: `gemma-4-e2b-q2` is marked AVOID, and granite-4.1-8b is not in the catalog at all.
- Good, because no consumer breaks: every previously valid alias still resolves.
- Bad, because the tiers are no longer one family, so chat templates differ across them. A
  prompt tuned against `balanced` is not automatically tuned against `fast`. node-llama-cpp
  reads the template from each GGUF, so this is a prompt-portability cost, not a correctness one.
- Bad, because `auto` now downloads different weights than before on the same machine. Anyone
  who wants the old behaviour must pin the alias explicitly.
- Neutral, because the measured quality differences between 1.4 GB and 5.5 GB are inside one
  standard error. The tiers are honestly a latency and headroom ladder, not a quality ladder,
  and the source comment now says so.

### Confirmation

`test/unit/llama-models.test.ts` pins one entry per tier, asserts the tiers are ordered by
ascending weight size (so `tierForBudget` stays monotonic), and asserts every superseded Gemma
alias still resolves and is untiered. `test/unit/llama-factory.test.ts` asserts a tier keyword
resolves via `aliasForTier` rather than a literal alias, so a future retiering does not have to
edit it.

Non-termination is **not** covered by an automated test: reproducing it costs a multi-gigabyte
download and minutes of inference per model. Re-run the benchmark by hand when adding a tier.

## Pros and Cons of the Options

### Keep the Gemma 4 tiers, re-rank on published benchmarks

- Good, because one family keeps chat templates identical across tiers.
- Good, because it costs nothing to decide.
- Bad, because IFEval does not measure what grammar-constrained decoding leaves to the model.
- Bad, because it cannot see non-termination at all — the failure that actually caused this ADR.

### Retier on a measurement of this library's own task

- Good, because it measures the workload the tiers exist to serve.
- Good, because it caught two runaway builds that published scores rate highly.
- Bad, because the corpus is one documentation set and two string fields; it under-represents
  the richer schemas that judging workloads use.
- Bad, because it must be re-run by hand, on a machine with the weights, to extend.

### Collapse to a single model

- Good, because measured quality barely varies with size across most of the range.
- Bad, because the measurement cannot resolve harder schemas than the corpus exercises, and
  collapsing on that evidence would bake in a limitation of the benchmark.
- Bad, because it removes the memory-budget ladder that `auto` depends on.
