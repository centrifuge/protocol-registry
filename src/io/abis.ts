/**
 * ABIs as built at a protocol tag.
 *
 * A tag's source never changes, so each tag is built once, by protocol's
 * .github/workflows/build-abis.yml when the tag is pushed, into one object per artifact:
 *
 *     abis/<tag>/<Artifact>.json    the artifact's ABI array
 *     abis/<tag>/manifest.json      { tag, commit, builtAt, artifacts } — written last, so a tag
 *                                   with a manifest is complete
 *
 * `commit` is the commit the tag pointed at when it was built. A tag moved since is refused until it is
 * built again, rather than served stale ABIs.
 */

export interface AbiManifest {
  tag: string;
  commit: string;
  builtAt: string;
  artifacts: string[];
}

/** R2 or a local directory with the layout above. */
export interface AbiStore {
  manifest(tag: string): Promise<AbiManifest | null>;
  abi(tag: string, artifactName: string): Promise<unknown[] | null>;
}

export const abiKey = (tag: string, name: string) => `abis/${tag}/${name}.json`;

export function r2AbiStore(bucket: R2Bucket): AbiStore {
  const read = async (key: string) => {
    const object = await bucket.get(key);
    return object ? await object.json() : null;
  };
  return {
    manifest: (tag) => read(abiKey(tag, "manifest")) as Promise<AbiManifest | null>,
    abi: (tag, name) => read(abiKey(tag, name)) as Promise<unknown[] | null>,
  };
}
