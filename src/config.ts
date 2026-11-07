/** The run configuration, from the Worker's vars, secrets and bindings. */

import type { Logger } from "./core/generate.ts";
import type { Network } from "./core/types.ts";
import { githubApp, type GitHub } from "./io/github.ts";
import { web3Gateway } from "./io/publish.ts";
import type { Publisher } from "./publisher.ts";
import type { HostnameRecords, RunConfig } from "./run.ts";

// `wrangler types` without the runtime types leaves the namespace untyped
export const publisher = (env: Env) =>
  (env.PUBLISHER as DurableObjectNamespace<Publisher>).getByName("publisher");

function hostnameRecords(env: Env): HostnameRecords {
  const stub = publisher(env);
  return {
    get: (network) => stub.hostnameRecord(network),
    put: (network, record) => stub.putHostnameRecord(network, record),
  };
}

export function github(env: Env): GitHub {
  return githubApp({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationRepo: env.SOURCE_REPO,
  });
}

export const hostnames = (env: Env): Record<Network, string> => ({
  mainnet: env.MAINNET_HOSTNAME,
  testnet: env.TESTNET_HOSTNAME,
});

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export function runConfig(env: Env, log: Logger = consoleLogger): RunConfig {
  return {
    gh: github(env),
    bucket: env.REGISTRY_BUCKET,
    gateway: env.CLOUDFLARE_API_TOKEN
      ? web3Gateway(env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ZONE_ID)
      : null,
    sourceRepo: env.SOURCE_REPO,
    hostnames: hostnames(env),
    hostnameRecords: hostnameRecords(env),
    pinataJwt: env.PINATA_JWT ?? null,
    log,
  };
}
