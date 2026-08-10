/**
 * Auto-installing the optional `node-llama-cpp` peer into a directory this
 * library owns.
 *
 * Every test drives a real temp prefix through an injected `ExecFn` standing in
 * for npm and an injected importer standing in for the module. Nothing here
 * spawns a process, reaches the network, or loads a native binary — the same
 * rule the rest of the suite follows.
 *
 * The property worth the most attention is that a FAILED install leaves no
 * shim: the shim is the marker that says "this prefix is ready", so writing it
 * before npm exits 0 would make a half-installed prefix look importable for the
 * rest of the machine's life.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InferenceError } from "../../src/index.js";
import {
  defaultLlamaRuntimeDirectory,
  importNodeLlamaCpp,
  nodeLlamaCppStatus,
  resetRuntimeInstall,
} from "../../src/providers/llama-install.js";
import type { ExecFn, ExecResult } from "../../src/index.js";

function prefix(): string {
  return mkdtempSync(join(tmpdir(), "inference-runtime-"));
}

function execResult(over: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: "", stderr: "", timedOut: false, ...over };
}

/** An npm that "succeeds" by creating the directory npm would have created. */
function fakeNpm(over: Partial<ExecResult> = {}): ExecFn & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((cmd: string[]) => {
    calls.push(cmd);
    return Promise.resolve(execResult(over));
  }) as ExecFn & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

const FAKE_MODULE = { getLlama: () => undefined } as unknown;
const importShim = (): Promise<unknown> => Promise.resolve(FAKE_MODULE);

afterEach(() => {
  resetRuntimeInstall();
  vi.restoreAllMocks();
});

describe("the runtime directory", () => {
  it("is this library's own, never node-llama-cpp's global one", () => {
    // The global directory is shared with node-llama-cpp's CLI; owning ours is
    // what makes writing into it safe.
    const dir = defaultLlamaRuntimeDirectory({});
    expect(dir).toContain(".hawkeyexl-inference");
    expect(dir).not.toContain(".node-llama-cpp");
  });

  it("honours INFERENCE_RUNTIME_DIR", () => {
    expect(
      defaultLlamaRuntimeDirectory({ INFERENCE_RUNTIME_DIR: "/mnt/runtime" }),
    ).toBe("/mnt/runtime");
  });
});

describe("installing into a fresh prefix", () => {
  it("runs npm against the prefix, pinned to the peer range", async () => {
    const directory = prefix();
    const exec = fakeNpm();

    await importNodeLlamaCpp({ directory, exec, importShim, env: {} });

    expect(exec.calls).toHaveLength(1);
    const cmd = exec.calls[0]!;
    expect(cmd[0]).toBe("npm");
    expect(cmd).toContain("install");
    expect(cmd).toContain("--prefix");
    expect(cmd).toContain(directory);
    // Below 3.19.0 there is no Gemma 4 support, so nothing in the catalog loads.
    expect(cmd.join(" ")).toContain("node-llama-cpp@^3.19.0");
  });

  it("anchors npm with a package.json so it cannot walk up and install elsewhere", async () => {
    const directory = prefix();
    await importNodeLlamaCpp({ directory, exec: fakeNpm(), importShim, env: {} });

    const manifest = join(directory, "package.json");
    expect(existsSync(manifest)).toBe(true);
    expect(JSON.parse(readFileSync(manifest, "utf8")).private).toBe(true);
  });

  it("writes an ESM shim that re-exports the package", async () => {
    const directory = prefix();
    await importNodeLlamaCpp({ directory, exec: fakeNpm(), importShim, env: {} });

    const shim = readFileSync(join(directory, "loader.mjs"), "utf8");
    // Resolution goes through Node's own rules from inside the prefix, so no
    // assumption is made about the package's `exports` map.
    expect(shim).toContain('export * from "node-llama-cpp"');
  });

  it("returns the imported module", async () => {
    const directory = prefix();
    const mod = await importNodeLlamaCpp({
      directory,
      exec: fakeNpm(),
      importShim,
      env: {},
    });
    expect(mod).toBe(FAKE_MODULE);
  });

  it("warns once before spending the download", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const directory = prefix();

    await importNodeLlamaCpp({ directory, exec: fakeNpm(), importShim, env: {} });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("node-llama-cpp");
    expect(message).toContain(directory);
  });
});

describe("status reporting", () => {
  // `absent` simulates a machine without the optional peer. That is the whole
  // point of the seam: on a machine that HAS it — this one, and CI, which
  // installs it as a devDependency — none of these branches are reachable, so
  // asserting them for real would silently test nothing.
  const absent = (): Promise<unknown> => Promise.reject(new Error("ENOENT"));
  const present = (): Promise<unknown> => Promise.resolve({});

  it("reports present when the consumer has their own copy", async () => {
    const status = await nodeLlamaCppStatus({
      directory: prefix(),
      probeImport: present,
      env: {},
    });
    expect(status.state).toBe("present");
  });

  it("reports present when only our prefix has it", async () => {
    const directory = prefix();
    writeFileSync(join(directory, "loader.mjs"), "");
    const status = await nodeLlamaCppStatus({
      directory,
      probeImport: absent,
      env: {},
    });
    expect(status.state).toBe("present");
  });

  it("reports installable without installing anything", async () => {
    // This is the property that keeps `availableProviders()` a query. If asking
    // what a machine can do were to fetch a native module, the picker it exists
    // to feed would cost minutes and gigabytes to draw.
    const directory = join(prefix(), "not-created-yet");
    const status = await nodeLlamaCppStatus({
      directory,
      probeImport: absent,
      env: {},
    });
    expect(status).toEqual({ state: "installable", directory });
    expect(existsSync(directory)).toBe(false);
  });

  it("reports refused under the opt-out", async () => {
    const status = await nodeLlamaCppStatus({
      directory: prefix(),
      probeImport: absent,
      env: { INFERENCE_NO_AUTO_INSTALL: "1" },
    });
    expect(status.state).toBe("refused");
    expect(status.state === "refused" && status.reason).toMatch(
      /INFERENCE_NO_AUTO_INSTALL/,
    );
  });

  it("still reports present under the opt-out when it is genuinely installed", async () => {
    // Refusing to INSTALL is not refusing to USE.
    const status = await nodeLlamaCppStatus({
      directory: prefix(),
      probeImport: present,
      env: { INFERENCE_NO_AUTO_INSTALL: "1" },
    });
    expect(status.state).toBe("present");
  });
});

describe("a prefix that is already installed", () => {
  it("reuses the shim without spawning npm", async () => {
    const directory = prefix();
    writeFileSync(join(directory, "loader.mjs"), 'export * from "node-llama-cpp";\n');
    const exec = fakeNpm();

    const mod = await importNodeLlamaCpp({ directory, exec, importShim, env: {} });

    expect(mod).toBe(FAKE_MODULE);
    expect(exec.calls).toEqual([]);
  });
});

describe("a failed install", () => {
  it("leaves no shim behind", async () => {
    // The shim is the readiness marker. Writing it before npm exits 0 would
    // make a half-installed prefix look importable forever.
    const directory = prefix();
    const exec = fakeNpm({ code: 1, stderr: "npm ERR! network timeout" });

    await expect(
      importNodeLlamaCpp({ directory, exec, importShim, env: {} }),
    ).rejects.toThrow(InferenceError);

    expect(existsSync(join(directory, "loader.mjs"))).toBe(false);
  });

  it("names the npm output so the failure is diagnosable", async () => {
    const directory = prefix();
    const exec = fakeNpm({ code: 1, stderr: "npm ERR! network timeout" });

    await expect(
      importNodeLlamaCpp({ directory, exec, importShim, env: {} }),
    ).rejects.toThrow(/network timeout/);
  });

  it("reports a missing npm rather than hanging", async () => {
    const directory = prefix();
    const exec = fakeNpm({ code: null, spawnError: "spawn npm ENOENT" });

    await expect(
      importNodeLlamaCpp({ directory, exec, importShim, env: {} }),
    ).rejects.toThrow(/npm/);
  });

  it("retries on the next call rather than poisoning the process", async () => {
    const directory = prefix();
    const failing = fakeNpm({ code: 1, stderr: "boom" });
    await expect(
      importNodeLlamaCpp({ directory, exec: failing, importShim, env: {} }),
    ).rejects.toThrow(InferenceError);

    const succeeding = fakeNpm();
    await expect(
      importNodeLlamaCpp({ directory, exec: succeeding, importShim, env: {} }),
    ).resolves.toBe(FAKE_MODULE);
    expect(succeeding.calls).toHaveLength(1);
  });
});

describe("the opt-out", () => {
  it("refuses to install when INFERENCE_NO_AUTO_INSTALL is set", async () => {
    const directory = prefix();
    const exec = fakeNpm();

    await expect(
      importNodeLlamaCpp({
        directory,
        exec,
        importShim,
        env: { INFERENCE_NO_AUTO_INSTALL: "1" },
      }),
    ).rejects.toThrow(/INFERENCE_NO_AUTO_INSTALL/);
    expect(exec.calls).toEqual([]);
  });
});

describe("concurrent callers", () => {
  // Two properties hold this up, and they are separate: the on-disk lock is
  // what makes npm run once (it survives across processes), and the in-process
  // memo is what keeps sibling workers off the lock's polling path entirely.
  // Asserting only the first passes even with the memo deleted — which is how
  // this pair came to be written.
  it("run npm once, however many callers arrive", async () => {
    // docmeta runs a worker pool, so several files can reach the runtime at the
    // same moment; two npm processes writing one prefix corrupts it.
    const directory = prefix();
    const exec = fakeNpm();

    const results = await Promise.all([
      importNodeLlamaCpp({ directory, exec, importShim, env: {} }),
      importNodeLlamaCpp({ directory, exec, importShim, env: {} }),
      importNodeLlamaCpp({ directory, exec, importShim, env: {} }),
    ]);

    expect(results).toEqual([FAKE_MODULE, FAKE_MODULE, FAKE_MODULE]);
    expect(exec.calls).toHaveLength(1);
  });

  it("share one in-flight promise rather than racing to the lock", async () => {
    const directory = prefix();
    const exec = fakeNpm();

    const first = importNodeLlamaCpp({ directory, exec, importShim, env: {} });
    const second = importNodeLlamaCpp({ directory, exec, importShim, env: {} });

    expect(second).toBe(first);
    await first;
  });

  it("stops sharing once the attempt has failed", async () => {
    const directory = prefix();
    const exec = fakeNpm({ code: 1, stderr: "boom" });

    const first = importNodeLlamaCpp({ directory, exec, importShim, env: {} });
    await expect(first).rejects.toThrow(InferenceError);

    const second = importNodeLlamaCpp({ directory, exec, importShim, env: {} });
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow(InferenceError);
  });
});
