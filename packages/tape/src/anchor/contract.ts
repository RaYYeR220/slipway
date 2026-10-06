// ForecastAnchor ABI (contracts/src/ForecastAnchor.sol) and read helpers.
import { createPublicClient, type Hex, http, type PublicClient, parseAbi } from "viem";
import { arbitrum } from "viem/chains";

export const FORECAST_ANCHOR_ABI = parseAbi([
  "function anchor(bytes32 root, uint64 count, uint64 fromTs, uint64 toTs) returns (uint256 index)",
  "function anchorCount() view returns (uint256)",
  "function anchorer() view returns (address)",
  "function protocolHash() view returns (bytes32)",
  "function genesisTs() view returns (uint64)",
  "function getAnchor(uint256 index) view returns ((bytes32 root, uint64 count, uint64 fromTs, uint64 toTs, uint64 anchoredAt))",
  "function verify(uint256 index, bytes32 entryHash, bytes32[] proof) view returns (bool)",
  "event Anchored(uint256 indexed index, bytes32 indexed root, uint64 count, uint64 fromTs, uint64 toTs)",
  "error NotAnchorer()",
  "error EmptyBatch()",
  "error NonContiguousWindow(uint64 expectedFrom, uint64 gotFrom)",
  "error InvalidWindow()",
  "error WindowNotClosed()",
  "error UnknownAnchor()",
]);

export const PUBLIC_ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";

export interface OnChainAnchor {
  index: number;
  root: Hex;
  count: number;
  fromTs: number;
  toTs: number;
  anchoredAt: number;
}

export const anchorClient = (rpc: string): PublicClient =>
  createPublicClient({ chain: arbitrum, transport: http(rpc) }) as PublicClient;

export async function readAnchors(client: PublicClient, address: Hex) {
  const c = { address, abi: FORECAST_ANCHOR_ABI } as const;
  const [count, genesisTs, protocolHash, anchorer] = await Promise.all([
    client.readContract({ ...c, functionName: "anchorCount" }),
    client.readContract({ ...c, functionName: "genesisTs" }),
    client.readContract({ ...c, functionName: "protocolHash" }),
    client.readContract({ ...c, functionName: "anchorer" }),
  ]);
  const anchors: OnChainAnchor[] = [];
  for (let i = 0; i < Number(count); i++) {
    const a = await client.readContract({ ...c, functionName: "getAnchor", args: [BigInt(i)] });
    anchors.push({
      index: i,
      root: a.root,
      count: Number(a.count),
      fromTs: Number(a.fromTs),
      toTs: Number(a.toTs),
      anchoredAt: Number(a.anchoredAt),
    });
  }
  return { genesisTs: Number(genesisTs), protocolHash, anchorer, anchors };
}
