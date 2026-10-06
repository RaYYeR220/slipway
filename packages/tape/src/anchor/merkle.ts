// Merkle tree matching ForecastAnchor.verify: leaf = keccak256(bytes32 entryHash), parent = keccak256 of the two
// children in ascending order; an unpaired node is carried up unchanged.
import { concatHex, type Hex, keccak256 } from "viem";

export const toBytes32 = (sha256Hex: string): Hex => {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error(`not a sha256 hex digest: ${sha256Hex}`);
  return `0x${sha256Hex}`;
};

export const leafOf = (entryHash: string): Hex => keccak256(toBytes32(entryHash));

const pair = (a: Hex, b: Hex): Hex => (a < b ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a])));

export function merkleLevels(leaves: readonly Hex[]): Hex[][] {
  if (leaves.length === 0) throw new Error("empty tree");
  const levels: Hex[][] = [[...leaves]];
  while ((levels.at(-1) as Hex[]).length > 1) {
    const cur = levels.at(-1) as Hex[];
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2)
      next.push(i + 1 < cur.length ? pair(cur[i] as Hex, cur[i + 1] as Hex) : (cur[i] as Hex));
    levels.push(next);
  }
  return levels;
}

export const merkleRoot = (entryHashes: readonly string[]): Hex =>
  (merkleLevels(entryHashes.map(leafOf)).at(-1) as Hex[])[0] as Hex;

export function merkleProof(entryHashes: readonly string[], index: number): Hex[] {
  const levels = merkleLevels(entryHashes.map(leafOf));
  const proof: Hex[] = [];
  let i = index;
  for (const level of levels.slice(0, -1)) {
    const sib = i % 2 === 0 ? i + 1 : i - 1;
    if (sib < level.length) proof.push(level[sib] as Hex);
    i = Math.floor(i / 2);
  }
  return proof;
}

/** Off-chain twin of ForecastAnchor.verify. */
export function verifyProof(root: Hex, entryHash: string, proof: readonly Hex[]): boolean {
  let node = leafOf(entryHash);
  for (const p of proof) node = pair(node, p);
  return node === root;
}
