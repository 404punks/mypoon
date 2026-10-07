import { Connection, PublicKey } from "@solana/web3.js";
import { getTokenMetadata } from "@solana/spl-token";
import { bondingCurveMarketCap } from "@pump-fun/pump-sdk";
import BN from "bn.js";

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const TRADE_DISCRIMINATOR = [189, 219, 127, 211, 78, 230, 97, 238];

export type CurveTrade = {
  signature: string;
  isBuy: boolean;
  solAmount: BN;
  tokenAmount: BN;
  user: string;
  timestamp: number;
  virtualSolReserves: BN;
  virtualTokenReserves: BN;
};

export type CoinMeta = {
  name: string;
  symbol: string;
  image?: string;
  description?: string;
};

export type ChartPoint = { price: number; time: number };
export type ParsedTrade = Omit<CurveTrade, "signature"> & { mint: string };

export function bondingCurveAddress(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM_ID,
  )[0];
}

function readU64(data: Uint8Array, offset: number) {
  let value = new BN(0);
  for (let index = 7; index >= 0; index -= 1) value = value.shln(8).iaddn(data[offset + index]);
  return value;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Decodes a Pump `TradeEvent` from an Anchor `Program data:` log line. */
export function parseTradeLog(line: string): ParsedTrade | null {
  if (!line.startsWith("Program data: ")) return null;
  let raw: Uint8Array;
  try {
    raw = decodeBase64(line.slice("Program data: ".length));
  } catch {
    return null;
  }
  if (raw.length < 113 || !TRADE_DISCRIMINATOR.every((byte, index) => raw[index] === byte)) return null;
  try {
    return {
      mint: new PublicKey(raw.subarray(8, 40)).toBase58(),
      isBuy: raw[56] === 1,
      solAmount: readU64(raw, 40),
      tokenAmount: readU64(raw, 48),
      user: new PublicKey(raw.subarray(57, 89)).toBase58(),
      timestamp: Number(readU64(raw, 89).toString()),
      virtualSolReserves: readU64(raw, 97),
      virtualTokenReserves: readU64(raw, 105),
    };
  } catch {
    return null;
  }
}

export function solPerWholeToken(virtualSol: BN, virtualTokens: BN) {
  if (virtualTokens.isZero()) return 0;
  return Number(virtualSol.mul(new BN(1_000_000)).div(virtualTokens).toString()) / 1e9;
}

export function lamportsToNumber(value: BN) {
  return Number(value.toString()) / 1e9;
}

export function quoteMarketCap(curve: {
  tokenTotalSupply: BN;
  virtualQuoteReserves: BN;
  virtualTokenReserves: BN;
}) {
  return bondingCurveMarketCap({
    mintSupply: curve.tokenTotalSupply,
    virtualQuoteReserves: curve.virtualQuoteReserves,
    virtualTokenReserves: curve.virtualTokenReserves,
  });
}

export function formatSolNumber(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (value >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (value >= 0.00000001) return value.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return value.toExponential(2);
}

export function formatUsd(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 1000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  if (value >= 0.000001) return `$${value.toFixed(8).replace(/0+$/, "")}`;
  return `$${value.toExponential(2)}`;
}

export function toHttpUrl(uri: string) {
  const trimmed = uri.trim();
  if (trimmed.startsWith("ipfs://")) {
    const path = trimmed.slice("ipfs://".length).replace(/^ipfs\//, "");
    return `https://ipfs.io/ipfs/${path}`;
  }
  return trimmed;
}

export function chartPoints(trades: CurveTrade[], liveSol?: BN, liveTokens?: BN): ChartPoint[] {
  const points = [...trades]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((trade) => ({
      price: solPerWholeToken(trade.virtualSolReserves, trade.virtualTokenReserves),
      time: trade.timestamp,
    }));
  if (liveSol && liveTokens && !liveTokens.isZero() && !liveSol.isZero()) {
    const live = solPerWholeToken(liveSol, liveTokens);
    if (points.length === 0) return [{ price: live, time: 0 }, { price: live, time: 1 }];
    const last = points[points.length - 1].price;
    if (last === 0 || Math.abs(last - live) / last > 0.001) points.push({ price: live, time: Math.floor(Date.now() / 1000) });
  }
  if (points.length === 1) return [points[0], { ...points[0] }];
  return points;
}

async function transactionLogs(endpoint: string, signature: string) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed", encoding: "json" }],
    }),
  });
  if (!response.ok) throw new Error(`History request failed (${response.status}).`);
  const json = await response.json() as { error?: { message?: string }; result?: { meta?: { logMessages?: string[] | null } } | null };
  if (json.error) throw new Error(json.error.message || "History request failed.");
  return json.result?.meta?.logMessages ?? [];
}

export async function loadCurveTrades(connection: Connection, mint: PublicKey) {
  const signatures = await connection.getSignaturesForAddress(bondingCurveAddress(mint), { limit: 20 });
  const trades: CurveTrade[] = [];
  let failures = 0;
  for (let index = 0; index < signatures.length; index += 4) {
    const batch = signatures.slice(index, index + 4);
    const logs = await Promise.all(batch.map(async (item) => {
      try {
        return await transactionLogs(connection.rpcEndpoint, item.signature);
      } catch {
        failures += 1;
        return [];
      }
    }));
    logs.forEach((lines, batchIndex) => {
      for (const line of lines) {
        const parsed = parseTradeLog(line);
        if (!parsed || parsed.mint !== mint.toBase58()) continue;
        const { mint: _mint, ...trade } = parsed;
        trades.push({ ...trade, signature: batch[batchIndex].signature });
      }
    });
  }
  if (signatures.length > 0 && failures === signatures.length) {
    throw new Error("Trade history could not be loaded from the RPC.");
  }
  return trades.sort((a, b) => b.timestamp - a.timestamp);
}

export async function loadCoinMeta(connection: Connection, mint: PublicKey, programId: PublicKey): Promise<CoinMeta | null> {
  const onChain = await getTokenMetadata(connection, mint, "confirmed", programId);
  if (!onChain) return null;
  const meta: CoinMeta = {
    name: onChain.name.replace(/\0/g, "").trim() || "Pump coin",
    symbol: onChain.symbol.replace(/\0/g, "").trim() || "TOKEN",
  };
  const uri = onChain.uri.replace(/\0/g, "").trim();
  if (!uri) return meta;
  try {
    const response = await fetch(toHttpUrl(uri), { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return meta;
    const json = await response.json() as { name?: string; symbol?: string; image?: string; description?: string };
    if (json.name?.trim()) meta.name = json.name.trim();
    if (json.symbol?.trim()) meta.symbol = json.symbol.trim().slice(0, 16);
    if (json.description?.trim()) meta.description = json.description.trim();
    if (json.image?.trim()) meta.image = toHttpUrl(json.image);
  } catch {
    return meta;
  }
  return meta;
}
