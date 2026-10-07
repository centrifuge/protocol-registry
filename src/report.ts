/**
 * What a run reports: the Registry Preview a pull request's check run carries, and the Slack message
 * a publish sends. One rendering of the same facts, so a reviewer and the channel read the same
 * numbers.
 */

import type { GenerateSummary } from "./core/generate.ts";
import type { Finding, Layer, Network } from "./core/types.ts";
import type { ValidationReport } from "./core/validate.ts";

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
  body += `| ABIs included | ${validation.summary.abis} |\n\n`;

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
