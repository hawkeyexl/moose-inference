---
status: "accepted"
date: 2026-08-14
decision-makers: [hawkeyexl]
consulted: []
informed: [docevals, dockg, agentevals, docmeta]
---

# Rename the package, repository, and docs site to `moose-inference`

## Context and Problem Statement

The library shipped as `@hawkeyexl/inference` out of `hawkeyexl/inference`, with its docs at
`hawkeyexl.github.io/inference`. Both halves of that name are weak: `inference` is a generic noun
that says nothing about which inference layer this is, and the `@hawkeyexl` scope ties a shared
toolchain dependency to one person's namespace. The project is being given a product name,
`moose-inference`, and the name has to land in every place it is published from — npm, GitHub,
and the docs site — or the three surfaces disagree about what the thing is called.

The complication is that `@hawkeyexl/inference@0.3.0` is already live on npm and is consumed from
the registry by `docevals`, `dockg`, and `agentevals`. A rename is not a cosmetic edit; it is a
breaking change to the one identifier every consumer types.

## Decision Drivers

- Three consumers resolve this package by name from the registry; a rename breaks all of them at once.
- The GitHub Pages base path is derived from the repository name, so the repo name is baked into
  every base-absolute link in the docset (~190 of them).
- `INFERENCE_*` environment variables are read from consumers' CI configuration, which this repo
  cannot see or migrate.
- npm package names are permanent: the old name can be deprecated but never reused or redirected.
- A half-applied rename (npm renamed, repo not, or vice versa) is worse than either end state.

## Considered Options

- Rename to `@hawkeyexl/moose-inference`, keeping the existing npm scope
- Rename to unscoped `moose-inference`
- Rename only the repository and docs, leaving the published package name alone

## Decision Outcome

Chosen option: **unscoped `moose-inference`**, applied simultaneously to the npm package, the
GitHub repository (`hawkeyexl/moose-inference`), the Pages base path (`/moose-inference`), and
every prose reference.

The `INFERENCE_*` environment variables — `INFERENCE_MODELS_DIR`, `INFERENCE_RUNTIME_DIR`,
`INFERENCE_NO_AUTO_INSTALL`, `INFERENCE_LIVE_LLAMA` — are **deliberately left unrenamed**. They
are set in consumers' CI configuration and on operators' machines, neither of which this repo can
migrate. Renaming the package costs consumers one edit in one file; renaming the variables too
would cost them a hunt through environments this repo cannot enumerate, for no benefit beyond
symmetry. The same reasoning keeps the `JsonCache` warning label at `inference`: it is a log
prefix pinned by the warnings reference, and changing it buys nothing.

### Consequences

- Good, because the name is distinctive and no longer implies the library is personal to one
  namespace, which matters for a package four repos depend on.
- Good, because npm, GitHub, and the docs site now agree, and the rename is one atomic change
  rather than a drift that has to be reconciled later.
- Good, because consumers' environment configuration keeps working untouched.
- Bad, because it is a hard break: `docevals`, `dockg`, and `agentevals` must each change their
  dependency and every `from "@hawkeyexl/inference"` import. There is no registry-level alias that
  can soften this — npm has no rename or redirect.
- Bad, because `@hawkeyexl/inference` must be deprecated by hand on npm to point at the new name;
  nothing in this repository can do that, and until it happens the old package looks current.
- Bad, because npm OIDC trusted publishing is bound to a repository *and* a package name, so both
  must be reconfigured before the first release under the new name succeeds. See the header of
  [.github/workflows/release.yml](../.github/workflows/release.yml).
- Neutral, because GitHub redirects the old repository URL indefinitely, so existing clones,
  issue links, and the old Pages URL's inbound links degrade gracefully rather than 404 —
  except the Pages base path itself, which moves.

### Confirmation

`scripts/check-docs-links.mjs` pins `BASE` to `/moose-inference` and fails the Docs workflow if a
base-absolute link does not resolve to a generated route, so a half-renamed docset cannot merge.
`npm run build` plus `npx doc-detective` exercise the examples, which import the package by its
published name via Node's package self-reference — a stale name there fails to resolve rather
than silently passing. A residual reference to the old name is a `git grep` away:

```
git grep -In -e 'hawkeyexl/inference' -e '@hawkeyexl/inference'
```

## Pros and Cons of the Options

### `@hawkeyexl/moose-inference`

- Good, because the scope already exists, so no new namespace has to be claimed.
- Good, because scoped names cannot collide with an unrelated package taking the bare name later.
- Bad, because it keeps the shared toolchain dependency inside one person's namespace, which is
  the half of the old name that was actually worth losing.
- Bad, because it is longer at every call site for no gain in clarity.

### Unscoped `moose-inference`

- Good, because the product name stands on its own, matching how the project is referred to.
- Good, because the name was unclaimed on npm at the time of the decision.
- Neutral, because it is exactly as breaking as the scoped option — the identifier changes either way.
- Bad, because the bare namespace offers no protection against a future name conflict.

### Rename the repository and docs only

- Good, because it breaks no consumer.
- Bad, because the published artifact would still announce itself as `@hawkeyexl/inference` in
  every install command and import, which is the name people actually type.
- Bad, because it defers the break rather than removing it, and the cost of breaking three
  consumers only grows as more code imports the old name.
