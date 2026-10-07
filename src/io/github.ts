/**
 * GitHub, as the protocol-registry GitHub App: reading protocol-internal (env at a commit, tags,
 * commits), reporting on its pull requests (check runs), and starting ABI builds in this repository.
 *
 * The App authenticates with a JWT signed by its private key, exchanged for an installation token
 * that lasts an hour. Both repositories are under one organization installation, so one token serves
 * every call.
 */

import { isReadEnvPath, type EnvTree } from "../core/env.ts";
import type { SourceComparison } from "../core/version-tags.ts";
import type { FetchLike } from "./ipfs.ts";

const API = "https://api.github.com";

export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

export interface GitHubAppConfig {
  appId: string;
  /** PKCS#8 PEM. GitHub issues PKCS#1; convert with `openssl pkcs8 -topk8 -nocrypt`. */
  privateKey: string;
  /** A repository the App is installed on, to find the installation by. */
  installationRepo: string;
  fetchImpl?: FetchLike;
}

export type GitHub = <T>(method: string, path: string, body?: unknown) => Promise<T>;

function base64url(value: ArrayBuffer | string): string {
  const raw = typeof value === "string" ? value : String.fromCharCode(...new Uint8Array(value));
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A JWT for the App itself, valid for nine minutes (GitHub accepts at most ten). */
export async function appJwt(
  appId: string,
  privateKeyPem: string,
  now = Date.now(),
): Promise<string> {
  const body = privateKeyPem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  if (privateKeyPem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is PKCS#1; convert it with `openssl pkcs8 -topk8 -nocrypt -in key.pem`",
    );
  }
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const issuedAt = Math.floor(now / 1000) - 60; // clock drift
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: appId }));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

async function call<T>(
  fetchImpl: FetchLike,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "centrifuge-protocol-registry",
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new GitHubError(
      response.status,
      `GitHub ${method} ${path}: ${response.status} ${text.slice(0, 300)}`,
    );
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** A client authenticated as the App's installation, renewing its token before it expires. */
export function githubApp(config: GitHubAppConfig): GitHub {
  const fetchImpl = config.fetchImpl ?? fetch;
  let cached: { token: string; expiresAt: number } | null = null;

  const installationToken = async () => {
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const jwt = await appJwt(config.appId, config.privateKey);
    const installation = await call<{ id: number }>(
      fetchImpl,
      jwt,
      "GET",
      `/repos/${config.installationRepo}/installation`,
    );
    const issued = await call<{ token: string; expires_at: string }>(
      fetchImpl,
      jwt,
      "POST",
      `/app/installations/${installation.id}/access_tokens`,
    );
    cached = { token: issued.token, expiresAt: Date.parse(issued.expires_at) };
    return issued.token;
  };

  return async (method, path, body) =>
    call(fetchImpl, await installationToken(), method, path, body);
}

const isNotFound = (error: unknown) =>
  error instanceof GitHubError && (error.status === 404 || error.status === 422);

interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

interface Tree {
  sha: string;
  tree: TreeEntry[];
  truncated: boolean;
}

export async function branchHead(gh: GitHub, repo: string, branch: string): Promise<string> {
  const ref = await gh<{ object: { sha: string } }>(
    "GET",
    `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  return ref.object.sha;
}

/** `env/` at a commit: every path, and the contents of the files the generator reads. */
export async function envSnapshot(gh: GitHub, repo: string, sha: string): Promise<EnvTree> {
  const root = await gh<Tree>("GET", `/repos/${repo}/git/trees/${sha}`);
  const envEntry = root.tree.find((entry) => entry.path === "env" && entry.type === "tree");
  if (!envEntry) throw new Error(`${repo}@${sha} has no env/ directory`);

  const env = await gh<Tree>("GET", `/repos/${repo}/git/trees/${envEntry.sha}?recursive=1`);
  if (env.truncated) throw new Error(`${repo}@${sha}: env/ is too large to list in one call`);

  const blobs = env.tree.filter((entry) => entry.type === "blob");
  const files = new Map<string, string>();
  await Promise.all(
    blobs
      .filter((entry) => isReadEnvPath(entry.path))
      .map(async (entry) => {
        const blob = await gh<{ content: string; encoding: string }>(
          "GET",
          `/repos/${repo}/git/blobs/${entry.sha}`,
        );
        const bytes = Uint8Array.from(atob(blob.content.replace(/\n/g, "")), (c) =>
          c.charCodeAt(0),
        );
        files.set(entry.path, new TextDecoder().decode(bytes));
      }),
  );
  return { paths: blobs.map((entry) => entry.path).sort(), files };
}

export async function tagExists(gh: GitHub, repo: string, tag: string): Promise<boolean> {
  try {
    await gh("GET", `/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** A commit's full sha and committer time (what `git show -s --format=%ct` gives), or null if unknown. */
export async function commitInfo(
  gh: GitHub,
  repo: string,
  ref: string,
): Promise<{ sha: string; timestamp: number } | null> {
  try {
    const commit = await gh<{ sha: string; commit: { committer: { date: string } } }>(
      "GET",
      `/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    );
    return {
      sha: commit.sha,
      timestamp: Math.floor(Date.parse(commit.commit.committer.date) / 1000),
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function subtree(gh: GitHub, repo: string, tree: Tree, name: string): Promise<Tree | null> {
  const entry = tree.tree.find((e) => e.path === name && e.type === "tree");
  return entry ? gh<Tree>("GET", `/repos/${repo}/git/trees/${entry.sha}`) : null;
}

/**
 * Compares `src/` (without `src/spell/`) and `src-ir/` between a tag and a commit, tree to tree: the
 * same comparison as `git diff <tag> <commit>`, which the compare API's merge-base diff is not.
 * Reports differing top-level entries.
 */
export async function compareSource(
  gh: GitHub,
  repo: string,
  tag: string,
  commit: string,
): Promise<SourceComparison> {
  let left: Tree;
  let right: Tree;
  try {
    left = await gh<Tree>("GET", `/repos/${repo}/git/trees/${encodeURIComponent(tag)}`);
    right = await gh<Tree>("GET", `/repos/${repo}/git/trees/${commit}`);
  } catch (error) {
    if (isNotFound(error)) {
      return { checked: false, reason: `commit ${commit} is not in ${repo} (was it ever pushed?)` };
    }
    throw error;
  }

  const differing: string[] = [];
  for (const dir of ["src", "src-ir"]) {
    const a = await subtree(gh, repo, left, dir);
    const b = await subtree(gh, repo, right, dir);
    if (a?.sha === b?.sha) continue;
    const entries = (tree: Tree | null) =>
      new Map((tree?.tree ?? []).map((entry) => [entry.path, entry.sha]));
    const ea = entries(a);
    const eb = entries(b);
    for (const name of new Set([...ea.keys(), ...eb.keys()])) {
      if (dir === "src" && name === "spell") continue;
      if (ea.get(name) !== eb.get(name)) differing.push(`${dir}/${name}`);
    }
  }
  return { checked: true, differing: differing.sort() };
}

export interface CheckRunOutput {
  title: string;
  summary: string;
  text?: string;
}

/** GitHub caps a check run's text at 65535 characters. */
const MAX_OUTPUT = 65000;

function clip(output: CheckRunOutput): CheckRunOutput {
  const cut = (value: string) =>
    value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n\n…(truncated)` : value;
  return {
    ...output,
    summary: cut(output.summary),
    ...(output.text && { text: cut(output.text) }),
  };
}

export const CHECK_NAME = "Registry preview";

export async function createCheckRun(
  gh: GitHub,
  repo: string,
  headSha: string,
  output: CheckRunOutput,
): Promise<number> {
  const run = await gh<{ id: number }>("POST", `/repos/${repo}/check-runs`, {
    name: CHECK_NAME,
    head_sha: headSha,
    status: "in_progress",
    output: clip(output),
  });
  return run.id;
}

export async function completeCheckRun(
  gh: GitHub,
  repo: string,
  id: number,
  conclusion: "success" | "failure" | "neutral",
  output: CheckRunOutput,
): Promise<void> {
  await gh("PATCH", `/repos/${repo}/check-runs/${id}`, {
    status: "completed",
    conclusion,
    output: clip(output),
  });
}

/** Paths a pull request changes. GitHub lists at most 3000. */
export async function pullRequestFiles(
  gh: GitHub,
  repo: string,
  number: number,
): Promise<string[]> {
  const paths: string[] = [];
  for (let page = 1; page <= 30; page++) {
    const files = await gh<{ filename: string; previous_filename?: string }[]>(
      "GET",
      `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    for (const file of files) {
      paths.push(file.filename);
      if (file.previous_filename) paths.push(file.previous_filename);
    }
    if (files.length < 100) break;
  }
  return paths;
}

export async function dispatchWorkflow(
  gh: GitHub,
  repo: string,
  workflow: string,
  ref: string,
  inputs: Record<string, string>,
): Promise<void> {
  await gh("POST", `/repos/${repo}/actions/workflows/${workflow}/dispatches`, { ref, inputs });
}

/** Verifies a webhook delivery's X-Hub-Signature-256 against the App's webhook secret. */
export async function verifyWebhookSignature(
  secret: string,
  body: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const hex = signatureHeader.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const signature = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
  // subtle.verify compares in constant time
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(body));
}
