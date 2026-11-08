/**
 * What a run reports: the Registry Preview a pull request's check run carries, and for a publish, a
 * check run on the published commit with the same report, and a short Slack message that links to
 * it. One rendering of the same facts, so a reviewer and the channel read the same numbers.
 */

import type { GenerateSummary } from "./core/generate.ts";
import type { Finding, Layer, Network } from "./core/types.ts";
import type { ValidationReport } from "./core/validate.ts";
import type { CheckConclusion } from "./io/github.ts";

export interface RetiredRow {
  chain: string;
  contract: string;
  address: string;
  endBlock: number;
}

/** One network's result, small enough to pass between workflow steps. */
export interface NetworkOutcome {
  network: Network;
  /** Generation stopped on purpose (RefusedError), with why. */
  refused?: string;
  summary?: GenerateSummary;
  validation?: ValidationReport;
  previousVersion?: string | null;
  contractsInLayer?: number;
  retired?: RetiredRow[];
}

export function retiredRows(registry: Layer): RetiredRow[] {
  return Object.entries(registry.chains).flatMap(([chain, data]) =>
    Object.entries(data.retired ?? {}).map(([address, entry]) => ({
      chain,
      contract: entry.contract,
      address,
      endBlock: entry.endBlock,
    })),
  );
}

export function contractsInLayer(registry: Layer): number {
  return Object.values(registry.chains).reduce(
    (sum, chain) => sum + Object.keys(chain.contracts ?? {}).length,
    0,
  );
}

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");

function findingsTable(icon: string, label: string, findings: Finding[]): string {
  if (findings.length === 0) return "";
  const rows = findings.map((f) => `| \`${cell(f.path)}\` | ${cell(f.message)} |`).join("\n");
  return `<details><summary>${icon} ${findings.length} ${label}</summary>\n\n| Path | Message |\n|------|---------|\n${rows}\n\n</details>\n\n`;
}

function modeLabel(outcome: NetworkOutcome): string {
  const mode = outcome.validation?.summary.mode ?? outcome.summary?.mode ?? "unknown";
  const previous = outcome.previousVersion ?? "none";
  if (mode === "patch") return `patch (replaces last \`${previous}\` registry on indexer merge)`;
  if (mode === "delta") return `delta (append onto \`${previous}\`)`;
  if (mode === "full") return "full snapshot";
  return mode;
}

/** The Registry Preview section for one network, as the PR comment it replaces laid it out. */
export function networkMarkdown(outcome: NetworkOutcome): string {
  let body = `### ${outcome.network}\n\n`;
  if (outcome.refused) {
    return `${body}❌ **Refused:** ${outcome.refused.replace(/\n/g, "\n> ")}\n\n`;
  }
  const { summary, validation } = outcome;
  if (!summary || !validation) return `${body}No result.\n\n`;

  const retired = outcome.retired ?? [];
  const delta = validation.summary.delta;
  body += `| Metric | Value |\n|--------|-------|\n`;
  body += `| Mode | ${modeLabel(outcome)} |\n`;
  body += `| Version | \`${summary.version ?? "null (patch layer)"}\` |\n`;
  body += `| Chains with changes | ${validation.summary.chains} |\n`;
  body += `| Contracts in delta | ${outcome.contractsInLayer ?? 0} |\n`;
  if (retired.length > 0) body += `| Retirements (listeners closed) | ${retired.length} |\n`;
  if (delta?.deltaRatio != null) {
    body += `| Delta size | ${outcome.contractsInLayer ?? 0} of ${delta.accumulatedContracts} published (${Math.round(delta.deltaRatio * 100)}%) |\n`;
  }
  const kept = delta?.keptContracts ?? 0;
  if (kept > 0) body += `| Kept as published (not in env, not retired) | ${kept} |\n`;
  body += `| ABIs included | ${validation.summary.abis} |\n\n`;

  if (validation.summary.chains === 0) {
    body += `Nothing to publish: no contract changed and no retirement is declared, so this layer is not pinned.\n\n`;
  }

  // Kept is the normal case (a missing key does not retire a contract), so it is listed for review
  // rather than raised as a warning: it is the set a retired.json declaration would close
  if (kept > 0) {
    const rows = Object.entries(delta?.keptByChain ?? {})
      .map(([chain, names]) => `| ${chain} | ${names.length} | ${names.join(", ")} |`)
      .join("\n");
    body += `<details><summary>${kept} published contract(s) kept as published</summary>\n\n| Chain | Count | Contracts |\n|-------|-------|-----------|\n${rows}\n\nA release is retired by declaring it in \`env/<environment>/retired.json\`.\n\n</details>\n\n`;
  }

  // A retirement is reviewed here: every listener the layer closes, by chain, with the block it ends
  // at (a count alone cannot catch a wrong release or a wrong chain)
  if (retired.length > 0) {
    const rows = retired
      .map((r) => `| ${r.chain} | ${r.contract} | \`${r.address}\` | ${r.endBlock} |`)
      .join("\n");
    body += `<details><summary>⊘ ${retired.length} listener(s) closed by this layer</summary>\n\n| Chain | Contract | Address | End block |\n|-------|----------|---------|-----------|\n${rows}\n\n</details>\n\n`;
  }

  body += findingsTable("❌", "error(s) — will break the indexer", validation.errors);
  body += findingsTable("⚠️", "warning(s)", validation.warnings);
  if (validation.errors.length === 0) {
    body +=
      validation.warnings.length === 0
        ? "✅ Passes all indexer requirements\n\n"
        : "✅ Passes all indexer hard requirements\n\n";
  }
  return body;
}

export function hasErrors(outcomes: NetworkOutcome[]): boolean {
  return outcomes.some((o) => o.refused || (o.validation?.errors.length ?? 0) > 0);
}

/**
 * The networks a publish goes ahead with. Each is judged on its own outcome: mainnet and testnet are
 * separate registries, so one's errors never hold back the other.
 */
export function toPublish<T extends NetworkOutcome & { publishable: boolean }>(outcomes: T[]): T[] {
  return outcomes.filter((o) => o.publishable && !hasErrors([o]));
}

/** One line per network, for a check run title or a Slack headline. */
export function headline(outcomes: NetworkOutcome[]): string {
  return outcomes
    .map((o) => {
      if (o.refused) return `${o.network}: refused`;
      if (!o.validation) return `${o.network}: no result`;
      if ((o.validation.errors.length ?? 0) > 0)
        return `${o.network}: ${o.validation.errors.length} error(s)`;
      if (!o.validation.summary.publishable) return `${o.network}: nothing to publish`;
      const retired = o.retired?.length ? `, ${o.retired.length} retired` : "";
      return `${o.network}: ${o.validation.summary.mode}, ${o.contractsInLayer ?? 0} contract(s)${retired}`;
    })
    .join(" · ");
}

/** A layer a publish pinned; `served` once the hostname points at it (PUBLISH_MODE live). */
export interface Published {
  network: Network;
  cid: string;
  served: boolean;
}

export interface PublishReport {
  outcomes: NetworkOutcome[];
  envProblems: string[];
  published: Published[];
  /** PUBLISH_MODE shadow: the networks that would have been published. */
  shadow: Network[];
  hostnames: Record<Network, string>;
}

/** The first line, or its first sentence, of a message: the rest is in the full report. */
function gist(text: string, max = 200): string {
  const line = text.split("\n")[0].replace(/:\s*$/, "");
  const sentence = /^.*?\.(?=\s)/.exec(line)?.[0] ?? line;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

function refusalGist(outcome: NetworkOutcome): string {
  if (outcome.refused) return gist(outcome.refused);
  const errors = outcome.validation?.errors ?? [];
  return `${errors.length} indexer error(s), the first at ${errors[0].path}: ${gist(errors[0].message)}`;
}

/**
 * What a publish did, one line per network it published or refused, for Slack and the publish check
 * run alike. A network with nothing to publish gets no line, so a run that changes nothing says
 * nothing. Detail stays in the report: a refusal can list hundreds of addresses.
 */
export function publishLines(report: PublishReport): string[] {
  const { outcomes, envProblems, published, shadow, hostnames } = report;
  if (envProblems.length > 0) {
    return [
      `❌ Registry publish refused: env/ has ${envProblems.length} problem(s), the first: ${gist(envProblems[0])}`,
    ];
  }
  const lines = published.map(({ network, cid, served }) =>
    served
      ? `✅ ${network} registry published: \`${cid}\` → https://${hostnames[network]}`
      : `📌 ${network} registry pinned, not served (PUBLISH_MODE is pin): https://centrifuge-files.mypinata.cloud/ipfs/${cid}`,
  );
  for (const network of shadow) {
    lines.push(
      `👻 ${network} registry would be published (PUBLISH_MODE is shadow): \`GET /runs/<run>/registry-${network}.json\``,
    );
  }
  for (const outcome of outcomes.filter((o) => hasErrors([o]))) {
    lines.push(`❌ ${outcome.network} registry refused: ${refusalGist(outcome)}`);
  }
  return lines;
}

/**
 * The check run a publish leaves on the commit it published from. A manual run gets its own name, so
 * it never hides the result of the push that published the commit. Its refusal is neutral: a run
 * someone tried by hand does not mark the release branch red.
 */
export function publishCheck(
  reason: string,
  refused: boolean,
): { name: string; conclusion: CheckConclusion } {
  const manual = reason === "manual";
  return {
    name: manual ? "Registry publish (manual)" : "Registry publish",
    conclusion: !refused ? "success" : manual ? "neutral" : "failure",
  };
}

export function previewMarkdown(outcomes: NetworkOutcome[], envProblems: string[] = []): string {
  let body = "";
  if (envProblems.length > 0) {
    body += `### env\n\n❌ ${envProblems.length} problem(s) in env/ — nothing was generated:\n\n`;
    body += envProblems.map((p) => `- ${p.replace(/\n/g, "\n  ")}`).join("\n");
    body += "\n\n";
  }
  for (const outcome of outcomes) body += networkMarkdown(outcome);
  return body;
}
