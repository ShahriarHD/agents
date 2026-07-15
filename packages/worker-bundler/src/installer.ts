/**
 * NPM package installer for virtual file systems.
 *
 * This module fetches packages from the npm registry and populates
 * a virtual node_modules directory structure.
 */

import * as semver from "semver";
import type { FileSystem } from "./file-system";

const NPM_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds
const DEFAULT_INSTALL_CONCURRENCY = 8;

/**
 * Create a simple concurrency limiter: at most `max` tasks run at once,
 * excess callers queue in FIFO order.
 */
function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Fetch with a timeout.
 * Throws an error if the request takes longer than the specified timeout.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Request to ${url} timed out after ${timeoutMs}ms (npm registry slow or unreachable from this Worker)`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

interface PackageJson {
  name: string;
  version: string;
  main?: string;
  module?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dist?: {
    tarball: string;
    integrity?: string;
  };
}

interface NpmPackageMetadata {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, PackageJson>;
}

/**
 * Which files from each package tarball are retained in the filesystem.
 *
 * - `"all"` keeps every text file a package publishes, including TypeScript
 *   declarations. Use this when the filesystem also feeds the TypeScript
 *   language service (`createTypescriptLanguageService`), which type-checks
 *   against `node_modules` `.d.ts` files.
 * - `"bundle"` keeps only what a bundle pass can load: source/dist code and
 *   importable assets. TypeScript declarations (`.d.ts`/`.d.mts`/`.d.cts`) and
 *   published test files are dropped. This is what `createWorker` uses — on a
 *   real-world dependency tree these files are a large fraction of the
 *   unpacked bytes and retaining them as strings can push a Worker past its
 *   isolate memory limit.
 *
 * Regardless of mode, files nothing in this package can ever read — source
 * maps, docs (`.md`), licenses/changelogs — are never retained.
 */
export type RetainMode = "all" | "bundle";

interface InstallOptions {
  /**
   * Include devDependencies (default: false)
   */
  dev?: boolean;

  /**
   * Registry URL (default: https://registry.npmjs.org)
   */
  registry?: string;

  /**
   * Which files from each package tarball to retain (default: "all").
   * See {@link RetainMode}.
   */
  retain?: RetainMode;

  /**
   * Maximum number of tarball downloads + extractions in flight at once
   * (default: 8). Each in-flight install holds the compressed tarball, the
   * fully gunzipped tar and the decoded file strings simultaneously, so
   * unbounded parallelism makes peak memory proportional to the whole
   * dependency tree rather than to the largest few packages. Metadata fetches
   * and dependency-graph traversal are not limited — only the buffer-heavy
   * fetch/extract stage.
   */
  concurrency?: number;
}

export interface InstallResult {
  /**
   * Packages that were freshly installed in this call.
   * Packages already present in the filesystem are skipped and not listed here.
   */
  installed: string[];

  /**
   * Warnings encountered during installation
   */
  warnings: string[];
}

/**
 * Install npm dependencies into a virtual file system.
 *
 * Reads the package.json from the files, resolves all dependencies,
 * and populates node_modules with the package contents.
 *
 * @param fileSystem - Virtual file system containing package.json
 * @param options - Installation options
 * @returns Metadata about the installation
 */
export async function installDependencies(
  fileSystem: FileSystem,
  options: InstallOptions = {}
): Promise<InstallResult> {
  const {
    dev = false,
    registry = NPM_REGISTRY,
    retain = "all",
    concurrency = DEFAULT_INSTALL_CONCURRENCY
  } = options;

  const result: InstallResult = {
    installed: [],
    warnings: []
  };

  // Read package.json
  const packageJsonContent = fileSystem.read("package.json");
  if (!packageJsonContent) {
    return result; // No package.json, nothing to install
  }

  let packageJson: PackageJson;
  try {
    packageJson = JSON.parse(packageJsonContent) as PackageJson;
  } catch {
    result.warnings.push("Failed to parse package.json");
    return result;
  }

  // Collect dependencies to install
  const depsToInstall: Record<string, string> = {
    ...packageJson.dependencies,
    ...(dev ? packageJson.devDependencies : {})
  };

  if (Object.keys(depsToInstall).length === 0) {
    return result; // No dependencies to install
  }

  const ctx: InstallContext = {
    result,
    fileSystem,
    // Track installed packages to avoid duplicates
    installedPackages: new Map(),
    // Track in-progress installations to avoid duplicate work
    inProgress: new Map(),
    registry,
    retain,
    limitExtraction: createLimiter(concurrency)
  };

  // Install all dependencies in parallel
  await Promise.all(
    Object.entries(depsToInstall).map(([name, versionRange]) =>
      installPackage(name, versionRange, ctx)
    )
  );

  return result;
}

/**
 * Shared state for one `installDependencies` run, threaded through the
 * recursive install. Kept as an object (rather than a long positional list)
 * so new install-wide state can be added without churning every call site.
 */
interface InstallContext {
  result: InstallResult;
  fileSystem: FileSystem;
  /** name -> resolved version (or "existing" for pre-warmed packages) */
  installedPackages: Map<string, string>;
  inProgress: Map<string, Promise<void>>;
  registry: string;
  retain: RetainMode;
  /** Caps concurrent tarball fetch/extract work — see InstallOptions.concurrency. */
  limitExtraction: <T>(task: () => Promise<T>) => Promise<T>;
}

/**
 * Install a single package and its dependencies recursively.
 */
async function installPackage(
  name: string,
  versionRange: string,
  ctx: InstallContext
): Promise<void> {
  const { result, fileSystem, installedPackages, inProgress, registry } = ctx;
  // Skip if already installed in this run
  if (installedPackages.has(name)) {
    return;
  }

  // Skip if the package already exists in the filesystem. This allows
  // installDependencies to be called on a pre-warmed FileSystem (e.g. after a
  // prior standalone installDependencies call, or a DO filesystem loaded from
  // KV) without triggering redundant network fetches for packages that are
  // already present. Transitive deps are assumed to also be present when the
  // top-level package.json is found.
  if (fileSystem.read(`node_modules/${name}/package.json`) !== null) {
    installedPackages.set(name, "existing");
    return;
  }

  // If installation is already in progress, wait for it
  const existing = inProgress.get(name);
  if (existing) {
    return existing;
  }

  // Create the installation promise
  const installPromise = (async () => {
    try {
      // Fetch package metadata from registry
      const metadata = await fetchPackageMetadata(name, registry);

      // Resolve version from range
      const version = resolveVersion(versionRange, metadata);
      if (!version) {
        result.warnings.push(
          `Could not resolve version for ${name}@${versionRange}`
        );
        return;
      }

      // Get the specific version metadata
      const versionMetadata = metadata.versions[version];
      if (!versionMetadata) {
        result.warnings.push(`Version ${version} not found for ${name}`);
        return;
      }

      // Mark as installed (before fetching to prevent cycles)
      installedPackages.set(name, version);
      result.installed.push(`${name}@${version}`);

      // Fetch and extract the package tarball. Limited so only a bounded
      // number of tarballs and their decompressed buffers exist at once;
      // the dependency recursion below stays outside the limiter, so this
      // cannot deadlock however deep the tree is.
      const packageFiles = await ctx.limitExtraction(() =>
        fetchPackageFiles(name, versionMetadata, ctx.retain)
      );

      // Add files to node_modules
      for (const [filePath, content] of Object.entries(packageFiles)) {
        fileSystem.write(`node_modules/${name}/${filePath}`, content);
      }

      // Install dependencies in parallel
      const deps = versionMetadata.dependencies ?? {};
      await Promise.all(
        Object.entries(deps).map(([depName, depVersion]) =>
          installPackage(depName, depVersion, ctx)
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(`Failed to install ${name}: ${message}`);
    }
  })();

  // Track in progress
  inProgress.set(name, installPromise);

  try {
    await installPromise;
  } finally {
    inProgress.delete(name);
  }
}

/**
 * Fetch package metadata from npm registry.
 */
async function fetchPackageMetadata(
  name: string,
  registry: string
): Promise<NpmPackageMetadata> {
  // Handle scoped packages
  const encodedName = name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1))}`
    : name;
  const url = `${registry}/${encodedName}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      // Use abbreviated metadata to avoid fetching megabytes of version data
      Accept:
        "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8"
    }
  });

  if (!response.ok) {
    // 404 on the registry usually means the package name is wrong (typo,
    // wrong scope) or the registry doesn't host it — call that out.
    const hint =
      response.status === 404
        ? " (package not found — check the name in package.json or set the `registry` option if it lives on a private registry)"
        : "";
    throw new Error(
      `Registry returned ${response.status} ${response.statusText} for "${name}" at ${url}${hint}`
    );
  }

  return (await response.json()) as NpmPackageMetadata;
}

/**
 * Resolve a semver range to a specific version.
 */
function resolveVersion(
  range: string,
  metadata: NpmPackageMetadata
): string | undefined {
  // Handle special cases
  if (range === "latest" || range === "*") {
    return metadata["dist-tags"]["latest"];
  }

  // Handle exact versions
  if (metadata.versions[range]) {
    return range;
  }

  // Handle dist-tags (e.g., "next", "beta")
  if (metadata["dist-tags"][range]) {
    return metadata["dist-tags"][range];
  }

  // Use semver.maxSatisfying to find the best matching version
  const versions = Object.keys(metadata.versions);
  const match = semver.maxSatisfying(versions, range);

  return match ?? undefined;
}

/**
 * Fetch and extract package files from npm tarball.
 */
export async function fetchPackageFiles(
  name: string,
  metadata: PackageJson,
  retain: RetainMode = "all"
): Promise<Record<string, string>> {
  const tarballUrl = metadata.dist?.tarball;
  if (!tarballUrl) {
    throw new Error(
      `Registry metadata for ${name}@${metadata.version} is missing \`dist.tarball\` — the registry response is likely malformed or the version was unpublished.`
    );
  }

  // Fetch the tarball (use longer timeout for potentially large packages)
  const response = await fetchWithTimeout(
    tarballUrl,
    {},
    DEFAULT_TIMEOUT_MS * 2
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch tarball for ${name}@${metadata.version}: ${response.status} ${response.statusText} (${tarballUrl})`
    );
  }

  // Get the tarball as array buffer
  const buffer = await response.arrayBuffer();

  // Extract the tarball (npm tarballs are gzipped tar files)
  return extractTarball(new Uint8Array(buffer), retain);
}

/**
 * Extract files from a gzipped tarball.
 *
 * npm packages are distributed as .tgz files (gzipped tar).
 * The contents are in a "package/" directory.
 */
async function extractTarball(
  data: Uint8Array,
  retain: RetainMode
): Promise<Record<string, string>> {
  // Decompress gzip
  const decompressed = await decompress(data);

  // Parse tar
  return parseTar(decompressed, retain);
}

/**
 * Decompress gzip data using DecompressionStream.
 */
async function decompress(data: Uint8Array): Promise<Uint8Array> {
  // Use DecompressionStream (available in Workers and modern browsers)
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Write compressed data
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});

  // Read decompressed data
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  // Concatenate chunks
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Parse a tar archive and extract text files.
 *
 * TAR format:
 * - 512-byte header blocks
 * - File content (padded to 512 bytes)
 * - Two empty blocks at the end
 */
function parseTar(
  data: Uint8Array,
  retain: RetainMode
): Record<string, string> {
  const files: Record<string, string> = {};
  const textDecoder = new TextDecoder();
  let offset = 0;

  while (offset < data.length - 512) {
    // Read header
    const header = data.slice(offset, offset + 512);

    // Check for empty block (end of archive)
    if (header.every((b) => b === 0)) {
      break;
    }

    // Parse header fields
    const name = readString(header, 0, 100);
    const sizeStr = readString(header, 124, 12);
    const typeFlag = header[156];

    // Parse size (octal)
    const size = parseInt(sizeStr.trim(), 8) || 0;

    // Move past header
    offset += 512;

    // Only process regular files (type '0' or '\0')
    if ((typeFlag === 48 || typeFlag === 0) && size > 0) {
      // Read file content
      const content = data.slice(offset, offset + size);

      // Remove "package/" prefix from npm tarballs
      let filePath = name;
      if (filePath.startsWith("package/")) {
        filePath = filePath.slice(8);
      }

      // Only include text files (skip binary files) that the retain mode keeps
      if (isTextFile(filePath) && shouldRetainFile(filePath, retain)) {
        try {
          files[filePath] = textDecoder.decode(content);
        } catch {
          // Skip files that can't be decoded as text
        }
      }
    }

    // Move to next block (content is padded to 512 bytes)
    offset += Math.ceil(size / 512) * 512;
  }

  return files;
}

/**
 * Read a null-terminated string from a buffer.
 */
function readString(
  buffer: Uint8Array,
  offset: number,
  length: number
): string {
  const bytes = buffer.slice(offset, offset + length);
  const nullIndex = bytes.indexOf(0);
  const relevantBytes = nullIndex >= 0 ? bytes.slice(0, nullIndex) : bytes;
  return new TextDecoder().decode(relevantBytes);
}

/**
 * Check if a file path is likely a text file.
 */
function isTextFile(path: string): boolean {
  const textExtensions = [
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".mts",
    ".cts",
    ".tsx",
    ".jsx",
    ".json",
    ".md",
    ".txt",
    ".css",
    ".html",
    ".yml",
    ".yaml",
    ".toml",
    ".xml",
    ".svg",
    ".map",
    ".d.ts",
    ".d.mts",
    ".d.cts"
  ];

  // Check common config files without extensions
  const configFiles = [
    "LICENSE",
    "README",
    "CHANGELOG",
    "package.json",
    "tsconfig.json",
    ".npmignore",
    ".gitignore"
  ];

  const fileName = path.split("/").pop() ?? "";

  if (
    configFiles.some((f) => fileName.toUpperCase().startsWith(f.toUpperCase()))
  ) {
    return true;
  }

  return textExtensions.some((ext) => path.toLowerCase().endsWith(ext));
}

/**
 * Decide whether an extracted tarball file is worth retaining in the
 * filesystem, per {@link RetainMode}.
 *
 * Every retained file lives in memory as a JS string for the lifetime of the
 * filesystem, so anything nothing in this package can read is dropped
 * unconditionally: source maps (the bundler never emits external maps and
 * strips references), docs, licenses and changelogs. `"bundle"` mode
 * additionally drops TypeScript declarations and published test files, which
 * only the TypeScript language service (not the bundler) can consume.
 */
function shouldRetainFile(path: string, retain: RetainMode): boolean {
  const lower = path.toLowerCase();
  const fileName = lower.split("/").pop() ?? "";

  // Never useful: source maps, docs, package metadata prose.
  if (
    lower.endsWith(".map") ||
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    fileName.startsWith("license") ||
    fileName.startsWith("licence") ||
    fileName.startsWith("changelog") ||
    fileName.startsWith("readme") ||
    fileName.startsWith("notice") ||
    fileName.startsWith("authors") ||
    fileName === ".npmignore" ||
    fileName === ".gitignore"
  ) {
    return false;
  }

  if (retain === "all") {
    return true;
  }

  // "bundle": the bundler can never load declarations or test files. If a
  // dropped file somehow IS imported, esbuild fails loudly with "File not
  // found" rather than silently misbehaving — switch to retain: "all" then.
  return !(
    lower.endsWith(".d.ts") ||
    lower.endsWith(".d.mts") ||
    lower.endsWith(".d.cts") ||
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("/__tests__/") ||
    lower.includes("/__mocks__/")
  );
}

/**
 * Check if files contain a package.json with dependencies that need installing.
 */
export function hasDependencies(files: FileSystem): boolean {
  const packageJson = files.read("package.json");
  if (!packageJson) return false;

  try {
    const pkg = JSON.parse(packageJson);
    const deps = pkg.dependencies ?? {};
    return Object.keys(deps).length > 0;
  } catch {
    return false;
  }
}
