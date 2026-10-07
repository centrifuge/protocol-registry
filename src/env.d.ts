// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them; see the list there.
// Merges into the generated binding types, which both Env and Cloudflare.Env extend.
interface __BaseEnv_Env {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  ETHERSCAN_API_KEY?: string;
  PINATA_JWT: string;
  CLOUDFLARE_API_TOKEN: string;
  SLACK_WEBHOOK_URL?: string;
  MANUAL_TRIGGER_TOKEN?: string;
}
