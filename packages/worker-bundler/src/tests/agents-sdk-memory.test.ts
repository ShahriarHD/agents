import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createWorker } from "../index";
import { InMemoryFileSystem } from "../file-system";
import type { CreateWorkerResult } from "../types";

/**
 * E2E: bundle a worker that depends on the `agents` SDK — the package
 * published from this very monorepo.
 *
 * This is the real-world shape reported by platform consumers (e.g.
 * unfolder.space's SpaceBuilder isolate): a user worker whose package.json
 * depends on `agents`, bundled inside a production Worker with the standard
 * 128 MB isolate memory limit. Today that install pulls the FULL flat
 * transitive tree — ~190 packages / ~12,000 files / ~90 MB unpacked — and the
 * installer retains every text file (including *.map, *.md, *.d.ts) as JS
 * strings in the in-memory FileSystem, while tarballs are fetched and
 * decompressed with unbounded parallelism. In production this exceeds the
 * 128 MB isolate limit and the build dies.
 *
 * workerd does NOT enforce the production memory limit locally, and its
 * node:v8 getHeapStatistics() is a zero-stub, so the OOM itself cannot be
 * observed under vitest-pool-workers. Instead this suite asserts the two
 * things that must both hold for the bundle to be producible in production:
 *
 *  1. Correctness — the bundle builds, boots in the Worker Loader, and the
 *     `Agent` export is real.
 *  2. Memory envelope — the bytes the installer retains in the FileSystem
 *     (which coexist with esbuild-wasm's own copy of every loaded file during
 *     the bundle pass) fit within a budget that leaves room for the rest of
 *     the 128 MB isolate.
 */

/**
 * Production Workers isolate memory limit.
 */
const WORKERS_ISOLATE_LIMIT_BYTES = 128 * 1024 * 1024;

/**
 * Budget for text retained in the FileSystem after `createWorker`.
 *
 * During the esbuild pass the retained input coexists with (at least):
 *  - esbuild-wasm's module + linear memory, which receives its own UTF-8 copy
 *    of every file the build loads plus AST/link-time structures,
 *  - the output bundle string,
 *  - transient install buffers (tarball + gunzipped tar + decoded strings)
 *    for whatever installs are still in flight.
 *
 * So retained input must be a modest fraction of the 128 MB isolate — a
 * quarter of the limit is already generous.
 */
const RETAINED_NODE_MODULES_BUDGET_BYTES = WORKERS_ISOLATE_LIMIT_BYTES / 4;

const AGENTS_WORKER_FILES = {
  "src/index.ts": [
    'import { Agent } from "agents";',
    "",
    "export class MyAgent extends Agent {",
    "  async onRequest() {",
    '    return new Response("hello from MyAgent");',
    "  }",
    "}",
    "",
    "export default {",
    "  fetch() {",
    "    return new Response(typeof Agent);",
    "  }",
    "};"
  ].join("\n"),
  "wrangler.toml": [
    'main = "src/index.ts"',
    'compatibility_date = "2026-01-01"',
    'compatibility_flags = ["nodejs_compat"]'
  ].join("\n"),
  "package.json": JSON.stringify({
    dependencies: {
      agents: "0.17.3"
    }
  })
};

interface BuiltAgentsWorker {
  result: CreateWorkerResult;
  fs: InMemoryFileSystem;
}

// The install downloads ~90 MB from the live npm registry; build once and
// share across the assertions in this file.
let builtPromise: Promise<BuiltAgentsWorker> | null = null;
function buildAgentsWorker(): Promise<BuiltAgentsWorker> {
  builtPromise ??= (async () => {
    const fs = new InMemoryFileSystem(AGENTS_WORKER_FILES);
    const result = await createWorker({ files: fs });
    return { result, fs };
  })();
  return builtPromise;
}

/** Sum of retained content bytes for all files under `prefix`. */
function retainedBytes(fs: InMemoryFileSystem, prefix: string): number {
  let total = 0;
  for (const path of fs.list(prefix)) {
    total += fs.read(path)?.length ?? 0;
  }
  return total;
}

const LONG_TIMEOUT = { timeout: 300_000, retry: 0 } as const;

describe("agents SDK e2e (live npm registry)", () => {
  // KNOWN FAILURE (2026-07): boot dies with `No such module
  // "cloudflare-internal:email"`. The agents main entry has a top-level
  // `import { EmailMessage } from "cloudflare:email"` and the bundler
  // correctly leaves cloudflare:* external — but Worker Loader child isolates
  // are not given the cloudflare:email module (the parent worker CAN import
  // it; a child with identical compatibility flags cannot). Until the runtime
  // provides it (or the bundler learns to shim it), a bundle of `agents`
  // cannot boot in env.LOADER at all.
  it(
    "bundles, boots and runs a worker that imports the agents SDK",
    LONG_TIMEOUT,
    async () => {
      const { result } = await buildAgentsWorker();

      expect(result.mainModule).toBe("bundle.js");
      expect(typeof result.modules["bundle.js"]).toBe("string");

      const worker = env.LOADER.get("agents-sdk-e2e", () => ({
        mainModule: result.mainModule,
        modules: result.modules,
        compatibilityDate:
          result.wranglerConfig?.compatibilityDate ?? "2026-01-01",
        compatibilityFlags: result.wranglerConfig?.compatibilityFlags
      }));

      const response = await worker
        .getEntrypoint()
        .fetch(new Request("http://worker/"));
      expect(response.status).toBe(200);
      // The Agent class made it into the bundle and evaluated at boot.
      expect(await response.text()).toBe("function");
    }
  );

  it(
    "keeps the installed tree within the 128 MB isolate memory envelope",
    LONG_TIMEOUT,
    async () => {
      const { fs } = await buildAgentsWorker();

      const retained = retainedBytes(fs, "node_modules/");

      // Diagnostics: where the bytes actually go, so a failure is actionable.
      const byExtension = new Map<string, number>();
      const byPackage = new Map<string, number>();
      for (const path of fs.list("node_modules/")) {
        const size = fs.read(path)?.length ?? 0;
        const base = path.slice(path.lastIndexOf("/") + 1);
        const ext = base.includes(".")
          ? base.slice(base.indexOf("."))
          : "(none)";
        byExtension.set(ext, (byExtension.get(ext) ?? 0) + size);
        const segments = path.split("/");
        const pkg = segments[1]?.startsWith("@")
          ? `${segments[1]}/${segments[2]}`
          : segments[1];
        byPackage.set(pkg, (byPackage.get(pkg) ?? 0) + size);
      }
      const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
      const top = (m: Map<string, number>, n: number) =>
        [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, n)
          .map(([k, v]) => `${k}: ${mb(v)}`)
          .join(", ");
      console.log(
        `agents install retained ${mb(retained)} across ${fs.list("node_modules/").length} files\n` +
          `  top extensions — ${top(byExtension, 10)}\n` +
          `  top packages — ${top(byPackage, 10)}`
      );

      expect(
        retained,
        `installing \`agents\` retained ${mb(retained)} of file content in memory; ` +
          `at most ${mb(RETAINED_NODE_MODULES_BUDGET_BYTES)} fits alongside esbuild-wasm ` +
          `and install buffers in a ${mb(WORKERS_ISOLATE_LIMIT_BYTES)} production isolate`
      ).toBeLessThanOrEqual(RETAINED_NODE_MODULES_BUDGET_BYTES);
    }
  );
});
