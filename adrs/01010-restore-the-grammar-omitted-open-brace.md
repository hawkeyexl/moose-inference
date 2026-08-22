---
status: "accepted"
date: 2026-08-22
decision-makers: [hawkeyexl]
---

# Restore the opening brace that grammar-constrained generation omits

## Context and Problem Statement

`--local` did not work. Not intermittently — `LlamaCppProvider.completeJSON` failed on every call
against real weights, and had done since the local provider shipped.

node-llama-cpp builds a GBNF grammar from the request schema, and the grammar accounts for the
opening `{` itself. `result.text` therefore begins at the first key:

```text
    "type": "how-to"
}
```

That reaches `extractJson`, fails `JSON.parse`, and falls through to the first-`{`-to-last-`}`
salvage. What happens next depends on the payload, and the worse case is the common one:

| Payload | Fallback finds | Surfaces as |
|---|---|---|
| flat object | no `{` at all | `Response contained no parseable JSON object` |
| contains an array | the first *element's* `{`, so the slice is `{...},{...}]}` | `Unexpected non-whitespace character after JSON at position 100` |

Neither message names the cause, and the second is actively misleading — it reads as a malformed
model response when the response was fine and the reassembly was not. A consumer cannot act on
either. `docmeta fill --local` reported `0 fields written · 1 errored` for every document, which is
how this was found.

The array row is not a corner case. It is the shape consumers ask for: docmeta's `fill` requests an
array of proposals, and any extraction task does the same.

## Why no test caught it

Every fixture in `test/unit/llama-cpp.test.ts` feeds text that already has the brace
(`'{"match":"pass","confidence":0.9}'`), because they were written from what the provider was
assumed to return rather than from what it does return. The fake `LlamaRuntime` is a permitted
double, but a double is only ever as good as the sample it was built from, and this one had never
been compared against real output.

`test/integration/live-llama.test.ts` uses real weights and would have caught the flat-object case.
It is gated on `INFERENCE_LIVE_LLAMA` and run by hand, so it did not.

## Decision

Repair the text in `LlamaCppProvider` before it reaches `extractJson`, via `restoreOpenBrace`.

The repair is deliberately narrow. It acts **only** when the text does not already parse on its own
**and** prepending `{` makes it parse. Anything else is returned untouched and handed to
`extractJson` exactly as before.

That narrowness is the point:

- a well-formed response can never be turned into `{{...}`;
- text broken some other way keeps its existing behaviour and its existing error;
- the repair cannot invent structure, because it is accepted only when it produces valid JSON.

It lives in `llama-cpp.ts` rather than in the shared `extractJson`, because this is a property of
grammar-constrained local generation. `openai-compat` and `claude-cli` return whole objects, and
widening the shared helper would change their behaviour to fix a bug they do not have.

## Consequences

- `--local` works. Verified end to end: `docmeta fill --local` writes `type: how-to` from
  Qwen3.5-4B-UD-Q4_K_XL with no network.
- `restoreOpenBrace` is exported, so a consumer hitting the same quirk through another path can
  reuse it rather than reimplement it.
- `live-llama.test.ts` gains a case whose payload is an array — the shape that made this a
  corruption risk rather than a plain error, and the shape unit fixtures were least likely to model.
- The unit fixtures remain brace-first. They now sit beside two that are not, captured verbatim
  from Qwen3.5-4B-UD-Q4_K_XL on node-llama-cpp 3.20.0.

## Pros and Cons of the Options

### Repair in `LlamaCppProvider` (chosen)

- Good, because it is scoped to the provider whose generation path has the quirk.
- Good, because the accept-only-if-it-parses guard makes it impossible to corrupt a good response.
- Bad, because it is a compensation for upstream behaviour, and will linger if node-llama-cpp
  changes. The guard makes it inert rather than wrong if that happens.

### Widen `extractJson` for every provider

- Good, because one code path.
- Bad, because it changes hosted-provider behaviour to fix a local-provider bug, and `extractJson`
  is exported and depended on by four repos.

### Ask node-llama-cpp to include the brace

- Good, because it fixes the cause rather than the symptom.
- Bad, because it does not help any consumer until it ships, and this library pins `^3.19.0` — a
  version range that must keep working either way.
