/**
 * Live local-model check. Skipped unless INFERENCE_LIVE_LLAMA is set, so the
 * default suite stays offline — no network in tests is a hard rule here.
 *
 * The first run downloads the `fast` tier (~2.6 GB) to this library's own models
 * directory (`defaultLlamaModelsDirectory()`, overridable with
 * `INFERENCE_MODELS_DIR`) and needs `node-llama-cpp` installed, since it is an
 * optional peer dependency:
 *
 *   npm i node-llama-cpp
 *   INFERENCE_LIVE_LLAMA=1 npx vitest run test/integration/live-llama.test.ts
 */
import { describe, expect, it, afterAll } from "vitest";
import {
  LLAMA_MODELS,
  costOfRuns,
  disposeLlamaModels,
  judge,
  makeProviderAsync,
  pricingFor,
  resolveProviderIdentityAsync,
} from "../../src/index.js";

const live = process.env["INFERENCE_LIVE_LLAMA"] ? describe : describe.skip;

const SYSTEM = [
  "You are a meticulous judge. Evaluate whether the supplied text satisfies",
  "the assertion. Respond with a JSON object matching the provided schema.",
].join("\n");

// Weights load once per process and hold gigabytes; a download makes the first
// call slow. Generous, because the alternative is a flaky timeout.
const TIMEOUT = 900_000;

live("live llama-cpp provider", () => {
  afterAll(async () => {
    await disposeLlamaModels();
  });

  it("resolves auto to a concrete catalog model on this machine", async () => {
    const identity = await resolveProviderIdentityAsync({
      provider: "llama-cpp",
    });
    expect(identity.provider).toBe("llama-cpp");
    // Never the literal selector — that is what the cache key records.
    expect(identity.model).not.toBe("auto");
    expect(LLAMA_MODELS[identity.model]).toBeDefined();
  }, 60_000);

  it("returns a schema-valid verdict for a clearly passing case", async () => {
    const provider = await makeProviderAsync({
      provider: "llama-cpp",
      model: "fast",
    });
    expect(provider.modelName()).toBe("gemma-4-e2b");

    const consensus = await judge({
      provider,
      system: SYSTEM,
      user: "# Assertion\nThe text mentions a cat.\n\n# Text\nThe cat sat on the mat.",
      runs: 1,
    });

    expect(consensus.runs[0]?.error).toBeUndefined();
    expect(consensus.verdict).toBe("pass");
    expect(consensus.runs[0]?.usage?.inputTokens).toBeGreaterThan(0);
    expect(consensus.runs[0]?.usage?.outputTokens).toBeGreaterThan(0);
  }, TIMEOUT);

  // The shape that hid a real defect for a whole release. Grammar-constrained
  // generation can return `result.text` without its opening `{`, and with an
  // array in the payload the old brace-slicing fallback latched onto the first
  // *element's* brace instead — so `completeJSON` failed with
  // "Unexpected non-whitespace character after JSON at position 100" on every
  // call. Every unit fixture fed text that already had the brace, so only real
  // weights could show it. Consumers use exactly this shape: docmeta's `fill`
  // asks for an array of proposals.
  it("returns a schema-valid object whose payload is an array", async () => {
    const provider = await makeProviderAsync({
      provider: "llama-cpp",
      model: "fast",
    });
    const result = await provider.completeJSON({
      system: "Extract every animal the text mentions.",
      user: "The cat sat on the mat. A dog watched.",
      schema: {
        type: "object",
        required: ["animals"],
        properties: {
          animals: {
            type: "array",
            items: {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string" } },
            },
          },
        },
      },
      temperature: 0,
    });
    const json = result.json as { animals?: { name?: string }[] };
    expect(Array.isArray(json.animals)).toBe(true);
    expect(json.animals?.length).toBeGreaterThan(0);
  }, TIMEOUT);

  it("runs a 3-run ensemble that costs nothing", async () => {
    const provider = await makeProviderAsync({
      provider: "llama-cpp",
      model: "fast",
    });
    const consensus = await judge({
      provider,
      system: SYSTEM,
      user: "# Assertion\nThe text mentions a dog.\n\n# Text\nThe cat sat on the mat.",
      runs: 3,
    });

    expect(consensus.runs).toHaveLength(3);
    for (const run of consensus.runs) expect(run.error).toBeUndefined();
    // Local inference has no price entry, so cost is 0 rather than a guess.
    expect(pricingFor(provider.modelName())).toBeUndefined();
    expect(costOfRuns(consensus.runs, pricingFor(provider.modelName()))).toBe(0);
  }, TIMEOUT);
});
