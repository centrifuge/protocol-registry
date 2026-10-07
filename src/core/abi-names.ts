/**
 * Env/registry contract key → Forge artifact name.
 *
 * Registry `chains.*.contracts` keys are camelCase (e.g. `fullRestrictionsHook`); the first letter is
 * uppercased for lookup. When that string does not match the Solidity contract / artifact name, it is
 * mapped here, so packing, validation and the delta's ABI-gap check stay aligned on one table.
 */

export const ABI_NAME_ALIASES: Record<string, string> = {
  Token: "ShareToken",
  NavManager: "NAVManager",
  FreezeOnlyHook: "FreezeOnly",
  FullRestrictionsHook: "FullRestrictions",
  FreelyTransferableHook: "FreelyTransferable",
  RedemptionRestrictionsHook: "RedemptionRestrictions",
};

export function capitalize(contractKey: string): string {
  return contractKey.charAt(0).toUpperCase() + contractKey.slice(1);
}

/** Forge artifact name for a capitalized env contract name. */
export function resolveArtifactName(capitalizedName: string): string {
  return ABI_NAME_ALIASES[capitalizedName] || capitalizedName;
}

/**
 * Artifact names required in `registry.abis` for one `chains.*.contracts` key. Includes the factory
 * product when the key ends with `Factory` (e.g. `tokenFactory` → `TokenFactory` + `ShareToken`).
 */
export function artifactNamesForContractKey(envContractKey: string): string[] {
  const capitalized = capitalize(envContractKey);
  const names = [resolveArtifactName(capitalized)];
  if (capitalized.endsWith("Factory")) {
    const base = capitalized.replace(/Factory$/, "");
    names.push(resolveArtifactName(base));
  }
  return names;
}
