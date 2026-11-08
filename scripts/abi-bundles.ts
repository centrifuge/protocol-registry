/**
 * The ABI bundles protocol's build-abis.yml uploads to R2, for local runs: read with
 * `wrangler r2 object get --remote` under the operator's wrangler login, and kept in a local directory
 * in the bucket's layout (`<dir>/<tag>/manifest.json`, `<dir>/<tag>/<Artifact>.json`, see
 * src/io/abis.ts). Only the artifacts a run asks for are fetched.
 *
 * A bundle is used only while its manifest records the commit the tag points at, as in the Worker: a
 * tag moved since its build is refused rather than served stale ABIs.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";

import { abiKey, type AbiManifest } from "../src/io/abis.ts";

export const BUCKET = "centrifuge-protocol-registry";

export interface AbiBundlesOptions {
  /** The local copy of the bundles. */
  dir: string;
  /** The commit a tag points at in the source checkout, or null when the checkout has no such tag. */
  tagCommit(tag: string): string | null;
  /** An object's text from the bucket; throws when it cannot be read. */
  fetchObject(key: string): Promise<string>;
}

const buildCommand = (tag: string) =>
  `gh workflow run build-abis.yml -R centrifuge/protocol-internal -f tag=${tag}`;

/** Written whole or not at all, so an interrupted run cannot leave a truncated file to be read later. */
function writeWhole(path: string, text: string): void {
  writeFileSync(`${path}.partial`, text);
  renameSync(`${path}.partial`, path);
}

/**
 * The generator's `abiAt`: an artifact's ABI as built at a tag, or null when that build has no such
 * artifact. Throws when the tag has no bundle built from the commit it points at.
 */
export function abiBundles({ dir, tagCommit, fetchObject }: AbiBundlesOptions) {
  const manifests = new Map<string, Promise<AbiManifest>>();

  async function manifestOf(tag: string): Promise<AbiManifest> {
    const commit = tagCommit(tag);
    const path = join(dir, tag, "manifest.json");
    if (existsSync(path)) {
      const kept = JSON.parse(readFileSync(path, "utf8")) as AbiManifest;
      if (kept.commit === commit) return kept;
    }

    let text: string;
    try {
      text = await fetchObject(abiKey(tag, "manifest"));
    } catch (error) {
      throw new Error(
        `Could not read the ABI bundle for ${tag} from R2: ${(error as Error).message}. ` +
          `If the tag has no bundle, build one: ${buildCommand(tag)}`,
        { cause: error },
      );
    }
    const manifest = JSON.parse(text) as AbiManifest;
    if (manifest.commit !== commit) {
      throw new Error(
        `The ABI bundle for ${tag} was built from ${manifest.commit}, but the tag points at ` +
          `${commit ?? "nothing"} in the source checkout. Fetch the checkout's tags if they are ` +
          `stale; if the tag moved, rebuild it: ${buildCommand(tag)}`,
      );
    }
    // Artifacts kept from a build of another commit describe other code
    rmSync(join(dir, tag), { recursive: true, force: true });
    mkdirSync(join(dir, tag), { recursive: true });
    writeWhole(path, text);
    return manifest;
  }

  return async (tag: string, artifactName: string): Promise<unknown[] | null> => {
    if (!manifests.has(tag)) manifests.set(tag, manifestOf(tag));
    const manifest = await manifests.get(tag)!;
    if (!manifest.artifacts.includes(artifactName)) return null;

    const path = join(dir, tag, `${artifactName}.json`);
    if (!existsSync(path)) writeWhole(path, await fetchObject(abiKey(tag, artifactName)));
    return JSON.parse(readFileSync(path, "utf8")) as unknown[];
  };
}

const run = promisify(execFile);

/** Reads an object from the bucket with wrangler, under an auth profile or wrangler's default login. */
export function wranglerObject(profile?: string): (key: string) => Promise<string> {
  return async (key) => {
    const args = ["exec", "wrangler", "r2", "object", "get", `${BUCKET}/${key}`, "--remote"];
    args.push("--pipe", ...(profile ? ["--profile", profile] : []));
    try {
      const { stdout } = await run("pnpm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const stderr = stripVTControlCharacters(String((error as { stderr?: unknown }).stderr ?? ""));
      const reason = stderr
        .split("\n")
        .find((line) => line.includes("[ERROR]"))
        ?.replace(/^.*\[ERROR\]\s*/, "");
      throw new Error(
        `wrangler r2 object get ${BUCKET}/${key}: ${reason ?? (error as Error).message}`,
        { cause: error },
      );
    }
  };
}
