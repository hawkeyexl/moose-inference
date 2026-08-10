---
status: "accepted"
date: 2026-08-10
decision-makers: [hawkeyexl]
---

# Auto-install the local runtime into a library-owned prefix, and refuse a model without a provider

## Context and Problem Statement

ADR 01004 made detection end at `llama-cpp`, on the grounds that it is the one provider needing no
key and no account — the last rung that always works. It does not always work. `node-llama-cpp` is
an **optional peer dependency**, and npm does not install optional peers, so the machine detection
was designed to rescue — no Anthropic key, no OpenAI key, no Claude CLI — is exactly the machine
where that last rung is missing too. Detection walks the whole chain and throws
`No inference provider is available`.

Separately, `resolveProviderIdentityAsync` carried `spec.model` into whichever provider detection
picked. A model name belongs to one provider, so `{ model: "gpt-4o-mini" }` on a machine with an
Anthropic key selected `anthropic` and then 404'd at call time — after the caller had already paid
for detection and everything leading to it.

## Decision Drivers

- The fallback must actually fall back. A last resort that fails on the machine it exists for is
  not one.
- A library must not edit its consumer's dependency manifest. Four repos consume this from the
  registry; a mutated `package.json` or lockfile breaks reproducible installs for all of them.
- Probing must not have the side effect it is probing for.
- No network in tests; every path exercisable through an injected seam.
- The library-not-a-tool invariant in CLAUDE.md: no CLI, no commands, no config loading.

## Considered Options

- Leave it: report unavailable with an actionable message
- `npm install node-llama-cpp` in the consumer's project
- `npm install --prefix` into a directory this library owns
- Vendor a prebuilt binary into this package

## Decision Outcome

Chosen: **`npm install --prefix` into a library-owned directory**, `~/.hawkeyexl-inference/runtime`
(`INFERENCE_RUNTIME_DIR` overrides), reached through a written ESM shim. `INFERENCE_NO_AUTO_INSTALL`
refuses it, restoring the previous behaviour exactly.

**This spawns npm, which sits past "no CLI, no commands" — so it needs saying plainly rather than
assuming ADR 01003 already licensed it.** What 01003 established is narrower and load-bearing: this
library already reaches the network unprompted, already writes gigabytes to disk, and already owns a
directory to make that safe. Installing a 5 MB native module into a second directory beside the
weights is the same act at smaller scale, immediately before the larger one. The invariant it must
not cross is the consumer's project, and it does not: nothing outside our own prefix is ever
written. A user who does not want it sets one variable.

Installing into the consumer's project was rejected outright. It mutates `package.json` and the
lockfile without consent, breaks reproducible installs, and fails or needs elevation under
`npm i -g` and `npx`. Vendoring a binary was rejected because it would put a per-platform native
artifact in a package whose entire dist is ~29 kB, for a feature most consumers never use.

### Resolution goes through a written shim, not `createRequire`

The prefix is not on Node's resolution path, so the installed package has to be reached explicitly.
The obvious move — `createRequire(...).resolve("node-llama-cpp", { paths: [prefix] })` — is wrong:
for a package with no `require` condition in its `exports` map it throws
`ERR_PACKAGE_PATH_NOT_EXPORTED`, and `import.meta.resolve` takes no parent-URL argument in its
stable form. Both would couple us to the internals of someone else's export map.

Instead the installer writes `<prefix>/loader.mjs` containing `export * from "node-llama-cpp";` and
imports *that*. Node then resolves the bare specifier from `<prefix>/node_modules` by its ordinary
rules — conditions, ESM/CJS interop, all of it — with no assumptions on our side. The four names
this library uses are named exports, so `export *` carries them.

**The shim doubles as the readiness marker, and is written only after npm exits 0.** Writing it
first would leave an interrupted install looking importable for the rest of the machine's life.
`test/unit/llama-install.test.ts` pins this by asserting a failed install leaves no shim; the
assertion was confirmed by inverting the order and watching it fail.

### Probing must not install

`probeLlamaCpp` previously called `getMemoryBudgetBytes()`, which now routes through the installer.
That would make `availableProviders()` — whose entire job is to report what a machine can do —
fetch a native module as a side effect of being asked, turning a picker query into minutes and
gigabytes.

So `nodeLlamaCppStatus()` answers `present` / `installable` / `refused` **without installing**, and
detection uses it. A binding that is genuinely present is still loaded for real during the probe,
because that is what catches one that is installed but whose backend fails to start. The install
happens later, when the provider is actually resolved, and warns once first.

### A model without a provider is now an error

`resolveProviderIdentityAsync` throws when `model` is set and `provider` is omitted or `"auto"`.
`model: null` keeps its documented meaning of "use the provider's default"; only a real name is
ambiguous. This reverses behaviour introduced days earlier in ADR 01004 and is a **breaking change**
for anyone who was relying on the pass-through — though relying on it meant relying on a 404.

### Consequences

- Good, because the fallback now works on the machine it was designed for, which was the entire
  point of ending the chain at a keyless provider.
- Good, because a consumer's `package.json`, lockfile and `node_modules` are never touched, so
  reproducible installs survive.
- Good, because `availableProviders()` stays a query.
- Good, because an ambiguous model fails at resolution instead of as a 404 mid-run.
- Bad, because the library now spawns a package manager, which is genuinely more than a library
  normally does. Mitigated by the owned prefix, the one-time warning, and the opt-out.
- Bad, because a platform without a prebuilt binary falls back to a CMake build that can take
  minutes. Hence the 15-minute timeout rather than `realExec`'s 60 seconds, and an error that says
  so.
- Bad, because npm must exist. Images shipping node without npm, or with only pnpm or yarn, get an
  actionable error rather than an install.

### Confirmation

`test/unit/llama-install.test.ts` drives a real temp prefix through an injected `ExecFn` for npm and
an injected importer, so nothing spawns a process, reaches the registry, or loads a native binary.
It pins: the pinned `^3.19.0` spec; the `package.json` anchor that stops npm walking up out of the
prefix; the shim's content and its write-after-success ordering; that a failed install leaves no
shim and retries next call; the opt-out; a missing npm; and that `nodeLlamaCppStatus` reports
`installable` without creating the directory.

Concurrency is pinned twice, deliberately: the lock file is what makes npm run once, and the
in-process memo is what keeps sibling workers off the polling path. A single "installs once"
assertion passed with the memo deleted — mutation testing caught that it was verifying the lock, not
the memo — so the two properties are now asserted separately.

`test/unit/detect.test.ts` covers the model-without-provider error and confirms `model: null` still
resolves to the default.

## Pros and Cons of the Options

### Leave it: report unavailable with an actionable message

- Good, because the library stays strictly a library, and nothing surprising happens.
- Good, because the error already names every probe and its fix.
- Bad, because `auto` dead-ends on precisely the machine it exists to serve, which makes the
  keyless last rung decorative.

### `npm install` in the consumer's project

- Good, because the module lands where Node already looks, with no shim.
- Bad, because it mutates `package.json` and the lockfile without consent.
- Bad, because it fails or needs elevation under `npm i -g` and `npx`.

### Vendor a prebuilt binary

- Good, because no install, no npm, no network at run time.
- Bad, because a package whose dist is ~29 kB would carry per-platform native artifacts for a
  feature most consumers never touch — the exact cost ADR 01003 made the peer dependency optional
  to avoid.
