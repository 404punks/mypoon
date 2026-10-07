import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  OnlinePumpSdk,
  PUMP_SDK,
} from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { ImagePlus, LoaderCircle, Search } from "lucide-react";
import {
  bondingCurveAddress,
  chartPoints,
  formatSolNumber,
  formatUsd,
  lamportsToNumber,
  loadCoinMeta,
  loadCurveTrades,
  quoteMarketCap,
  solPerWholeToken,
  type ChartPoint,
  type CoinMeta,
  type CurveTrade,
} from "./market";

type Route = { name: "home" } | { name: "launch" } | { name: "token"; mint: string; created: boolean };
type Side = "buy" | "sell";
type Notice = { kind: "success" | "error" | "info"; message: string; signature?: string };
type SavedCoin = {
  mint: string;
  name: string;
  symbol: string;
  image?: string;
  createdAt: number;
  holderReward: boolean;
};
type CurveState = Awaited<ReturnType<OnlinePumpSdk["fetchBuyState"]>> & {
  tokenProgram: PublicKey;
  supply: BN;
  balance: BN;
  global: Awaited<ReturnType<OnlinePumpSdk["fetchGlobal"]>>;
  feeConfig: Awaited<ReturnType<OnlinePumpSdk["fetchFeeConfig"]>>;
};
type LaunchForm = {
  name: string;
  symbol: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  initialBuy: string;
  metadataUri: string;
  image: File | null;
  holderReward: boolean;
  accepted: boolean;
};

const EXPLORER = "https://solscan.io";
const STORAGE_KEY = "stonklab.coins.v1";
const CREATED_KEY = "stonklab.created.v1";
const QUOTES = ["xStocks", "PreStocks", "Currencies", "Collectibles", "Solana", "Custom"];

const initialLaunch: LaunchForm = {
  name: "",
  symbol: "",
  description: "",
  website: "",
  twitter: "",
  telegram: "",
  initialBuy: "",
  metadataUri: "",
  image: null,
  holderReward: false,
  accepted: false,
};

function readRoute(): Route {
  const hash = location.hash.replace(/^#/, "") || "/";
  const queryAt = hash.indexOf("?");
  const path = queryAt === -1 ? hash : hash.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? "" : hash.slice(queryAt + 1));
  if (path.startsWith("/launch")) return { name: "launch" };
  if (path.startsWith("/token/")) {
    return { name: "token", mint: decodeURIComponent(path.slice("/token/".length)), created: params.get("created") === "1" };
  }
  return { name: "home" };
}

function go(path: string) {
  location.hash = path;
}

function toBaseUnits(value: string, decimals: number): BN {
  const normalized = value.trim();
  if (!/^\d*(\.\d*)?$/.test(normalized) || normalized === "." || Number(normalized) <= 0) {
    throw new Error("Enter a valid positive amount.");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) throw new Error(`Use no more than ${decimals} decimal places.`);
  return new BN((whole || "0") + fraction.padEnd(decimals, "0"));
}

function readU64(data: Uint8Array, offset: number) {
  let value = new BN(0);
  for (let index = 7; index >= 0; index -= 1) value = value.shln(8).iaddn(data[offset + index]);
  return value;
}

function fromBaseUnits(value: BN, decimals: number, precision = 4) {
  const negative = value.isNeg();
  const padded = value.abs().toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const fraction = padded.slice(-decimals).slice(0, precision).replace(/0+$/, "");
  return `${negative ? "-" : ""}${Number(whole).toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}

function shortAddress(value: string, size = 4) {
  return `${value.slice(0, size)}…${value.slice(-size)}`;
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("User rejected")) return "Transaction cancelled in your wallet.";
  if (message.includes("Attempt to debit")) return "Your wallet does not have enough SOL.";
  if (message.includes("429")) return "The public RPC is busy. Set VITE_SOLANA_RPC_URL to a private mainnet endpoint.";
  if (message.includes("Indexed requests") || message.includes("personal token")) return "This public RPC blocks that lookup. Set VITE_SOLANA_RPC_URL to a full mainnet endpoint.";
  if (message.includes("Access forbidden") || message.includes("403")) return "The Solana RPC refused the request. Reload after the latest deploy, or set VITE_SOLANA_RPC_URL to a mainnet endpoint that allows browser access.";
  if (message === "Failed to fetch") return "The metadata upload could not reach the server. Reload the page and try again.";
  return message.replace(/^Error: /, "").slice(0, 280);
}

function readCoins(): SavedCoin[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]") as SavedCoin[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistCoins(next: SavedCoin[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(0, 48).map((item) => ({
    ...item,
    image: item.image?.startsWith("blob:") ? undefined : item.image,
  }))));
  return next.slice(0, 48);
}

function saveCoin(coin: SavedCoin) {
  return persistCoins([coin, ...readCoins().filter((item) => item.mint !== coin.mint)]);
}

function upsertCoin(coin: SavedCoin) {
  const current = readCoins();
  const existing = current.find((item) => item.mint === coin.mint);
  if (!existing) return saveCoin(coin);
  return persistCoins(current.map((item) => item.mint === coin.mint
    ? { ...item, name: coin.name || item.name, symbol: coin.symbol || item.symbol, image: coin.image || item.image, holderReward: coin.holderReward }
    : item));
}

function rememberCreation(mint: string, signature: string) {
  sessionStorage.setItem(CREATED_KEY, JSON.stringify({ mint, signature }));
}

function readCreation(mint: string) {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(CREATED_KEY) || "null") as { mint?: string; signature?: string } | null;
    return parsed?.mint === mint ? parsed.signature || "" : "";
  } catch {
    return "";
  }
}

function buyLink(mint: string) {
  return `${location.origin}${location.pathname}#/token/${mint}`;
}

function relTime(timestamp: number) {
  const delta = Date.now() / 1000 - timestamp;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return new Date(timestamp * 1000).toLocaleString();
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

async function uploadMetadata(form: LaunchForm) {
  if (form.metadataUri.trim()) return form.metadataUri.trim();
  if (!form.image) throw new Error("Add a token image, or paste a metadata URI.");
  const payload = new FormData();
  payload.append("file", form.image);
  payload.append("name", form.name.trim());
  payload.append("symbol", form.symbol.trim().toUpperCase());
  payload.append("description", form.description.trim() || form.name.trim());
  payload.append("twitter", form.twitter.trim());
  payload.append("telegram", form.telegram.trim());
  payload.append("website", form.website.trim());
  payload.append("showName", "true");
  const response = await fetch("/api/ipfs", { method: "POST", body: payload });
  if (!response.ok) throw new Error(`Metadata upload failed (${response.status}). Use a metadata URI instead.`);
  const result = (await response.json()) as { metadataUri?: string };
  if (!result.metadataUri) throw new Error("Metadata service did not return a URI.");
  return result.metadataUri;
}

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 28 28" aria-hidden="true">
      <path d="M7 18.5 12 13l3.2 3.2L21 9.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 9.5H21V14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="copy-btn" onClick={() => {
      void copyText(value).then(() => {
        setDone(true);
        window.setTimeout(() => setDone(false), 1400);
      });
    }}>{done ? "Copied" : "Copy"}</button>
  );
}

function ShareRows({ mint }: { mint: string }) {
  const link = buyLink(mint);
  return (
    <>
      <div className="copy-row"><span>Contract</span><code title={mint}>{mint}</code><CopyButton value={mint} /></div>
      <div className="copy-row"><span>Buy link</span><code title={link}>{link}</code><CopyButton value={link} /></div>
    </>
  );
}

function PriceChart({ points }: { points: ChartPoint[] }) {
  if (points.length === 0) {
    return <div className="chart-empty">The chart appears after the bonding curve loads.</div>;
  }
  const width = 640;
  const height = 220;
  const pad = { l: 8, r: 8, t: 18, b: 12 };
  const prices = points.map((point) => point.price);
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (min === max) {
    const padPrice = Math.abs(min) * 0.04 || 1e-9;
    min -= padPrice;
    max += padPrice;
  }
  const xAt = (index: number) => pad.l + (points.length === 1 ? (width - pad.l - pad.r) / 2 : (index / (points.length - 1)) * (width - pad.l - pad.r));
  const yAt = (price: number) => pad.t + (1 - (price - min) / (max - min)) * (height - pad.t - pad.b);
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${xAt(index).toFixed(1)},${yAt(point.price).toFixed(1)}`).join(" ");
  const area = `${line} L${xAt(points.length - 1).toFixed(1)},${(height - pad.b).toFixed(1)} L${xAt(0).toFixed(1)},${(height - pad.b).toFixed(1)} Z`;
  const rising = points[points.length - 1].price >= points[0].price;
  const color = rising ? "#39d6a3" : "#fb7185";
  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Bonding curve price chart">
      {[0.25, 0.5, 0.75].map((mark) => (
        <line key={mark} x1={pad.l} x2={width - pad.r} y1={pad.t + mark * (height - pad.t - pad.b)} y2={pad.t + mark * (height - pad.t - pad.b)} stroke="#20363d" strokeWidth="1" />
      ))}
      <path d={area} fill={color} opacity="0.16" />
      <path d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={xAt(points.length - 1)} cy={yAt(points[points.length - 1].price)} r="4.5" fill={color} />
    </svg>
  );
}

export default function App() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const [route, setRoute] = useState<Route>(readRoute);
  const [coins, setCoins] = useState<SavedCoin[]>(() => readCoins());
  const [sort, setSort] = useState<"newest" | "name">("newest");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [launch, setLaunch] = useState<LaunchForm>(initialLaunch);
  const [preview, setPreview] = useState("");
  const [supplyLabel, setSupplyLabel] = useState("1,000,000,000");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [curve, setCurve] = useState<CurveState | null>(null);
  const [side, setSide] = useState<Side>("buy");
  const [tradeAmount, setTradeAmount] = useState("");
  const [slippage, setSlippage] = useState("1");
  const [quote, setQuote] = useState<BN | null>(null);
  const [meta, setMeta] = useState<CoinMeta | null>(null);
  const [trades, setTrades] = useState<CurveTrade[]>([]);
  const [historyState, setHistoryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [solUsd, setSolUsd] = useState(0);
  const marketRequest = useRef(0);

  const sdk = useMemo(() => new OnlinePumpSdk(connection), [connection]);
  const shown = [...coins].sort((a, b) => (sort === "name" ? a.symbol.localeCompare(b.symbol) : b.createdAt - a.createdAt));
  const matches = shown.filter((coin) => `${coin.name} ${coin.symbol} ${coin.mint}`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    const sync = () => setRoute(readRoute());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    sdk.fetchGlobal().then((global) => setSupplyLabel(fromBaseUnits(global.tokenTotalSupply, 6, 0))).catch(() => undefined);
  }, [sdk]);

  useEffect(() => {
    let cancelled = false;
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd")
      .then((response) => response.json())
      .then((data: { solana?: { usd?: number } }) => {
        if (!cancelled && typeof data.solana?.usd === "number") setSolUsd(data.solana.usd);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (route.name !== "home" || coins.length === 0) return;
    let cancelled = false;
    const rows = coins.slice(0, 24).flatMap((coin) => {
      try { return [{ mint: coin.mint, pda: bondingCurveAddress(new PublicKey(coin.mint)) }]; }
      catch { return []; }
    });
    if (rows.length === 0) return;
    connection.getMultipleAccountsInfo(rows.map((row) => row.pda)).then((accounts) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      accounts.forEach((account, index) => {
        if (!account) return;
        try {
          const decoded = PUMP_SDK.decodeBondingCurve(account);
          next[rows[index].mint] = decoded.complete || decoded.virtualTokenReserves.isZero()
            ? "Graduated"
            : `${formatSolNumber(lamportsToNumber(quoteMarketCap(decoded)))} SOL`;
        } catch { /* leave the card without a cap */ }
      });
      setCaps(next);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [coins, connection, route.name]);

  const send = useCallback(async (instructions: TransactionInstruction[], signers: Keypair[] = [], units = 400_000) => {
    if (!wallet.publicKey || !wallet.sendTransaction) throw new Error("Connect your wallet first.");
    const transaction = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ...instructions,
    );
    transaction.feePayer = wallet.publicKey;
    const latest = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = latest.blockhash;
    if (signers.length) transaction.partialSign(...signers);
    const signature = await wallet.sendTransaction(transaction, connection, { skipPreflight: false, preflightCommitment: "confirmed" });
    await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    return signature;
  }, [connection, wallet]);

  const tokenMint = route.name === "token" ? route.mint : "";

  const loadMarket = useCallback(async (mint: PublicKey, programId: PublicKey, holderReward: boolean) => {
    const request = ++marketRequest.current;
    setHistoryState("loading");
    setMeta(null);
    setTrades([]);
    const [metaResult, tradeResult] = await Promise.allSettled([
      loadCoinMeta(connection, mint, programId),
      loadCurveTrades(connection, mint),
    ]);
    if (request !== marketRequest.current) return;
    if (metaResult.status === "fulfilled" && metaResult.value) {
      const details = metaResult.value;
      setMeta(details);
      setCoins(upsertCoin({
        mint: mint.toBase58(),
        name: details.name,
        symbol: details.symbol,
        image: details.image,
        createdAt: Date.now(),
        holderReward,
      }));
    }
    if (tradeResult.status === "fulfilled") {
      setTrades(tradeResult.value);
      setHistoryState("ready");
    } else {
      setHistoryState("error");
    }
  }, [connection]);

  const loadCoin = useCallback(async (mintText: string) => {
    setBusy("load");
    setQuote(null);
    try {
      const mint = new PublicKey(mintText.trim());
      const user = wallet.publicKey ?? PublicKey.default;
      const mintAccount = await connection.getAccountInfo(mint);
      if (!mintAccount || (!mintAccount.owner.equals(TOKEN_PROGRAM_ID) && !mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID))) {
        throw new Error("That address is not a token mint.");
      }
      const [global, feeConfig, state] = await Promise.all([
        sdk.fetchGlobal(),
        sdk.fetchFeeConfig(),
        sdk.fetchBuyState(mint, user, mintAccount.owner),
      ]);
      const accountData = state.associatedUserAccountInfo?.data;
      const balance = accountData && accountData.length >= 72 ? readU64(accountData, 64) : new BN(0);
      setCurve({
        ...state,
        tokenProgram: mintAccount.owner,
        supply: state.bondingCurve.tokenTotalSupply,
        balance,
        global,
        feeConfig,
      });
      void loadMarket(mint, mintAccount.owner, state.bondingCurve.isHolderReward);
    } catch (error) {
      setCurve(null);
      setNotice({ kind: "error", message: friendlyError(error) });
    } finally {
      setBusy("");
    }
  }, [connection, loadMarket, sdk, wallet.publicKey]);

  useEffect(() => {
    if (!tokenMint) return;
    setTradeAmount("");
    setQuote(null);
    setSide("buy");
    void loadCoin(tokenMint);
  }, [loadCoin, tokenMint]);

  function quoteTrade(value: string, selected: Side, state = curve) {
    if (!state || !value) return setQuote(null);
    try {
      setQuote(selected === "buy"
        ? getBuyTokenAmountFromSolAmount({
            global: state.global,
            feeConfig: state.feeConfig,
            mintSupply: state.supply,
            bondingCurve: state.bondingCurve,
            amount: toBaseUnits(value, 9),
            quoteMint: state.quoteMint,
          })
        : getSellSolAmountFromTokenAmount({
            global: state.global,
            feeConfig: state.feeConfig,
            mintSupply: state.supply,
            bondingCurve: state.bondingCurve,
            amount: toBaseUnits(value, 6),
          }));
    } catch {
      setQuote(null);
    }
  }

  async function createToken(event: FormEvent) {
    event.preventDefault();
    if (!wallet.publicKey) return setVisible(true);
    if (!launch.accepted) return setNotice({ kind: "error", message: "Confirm that you understand this spends real SOL on mainnet." });
    if (!launch.name.trim() || launch.name.trim().length > 32) return setNotice({ kind: "error", message: "Name must be 1–32 characters." });
    if (!/^[A-Za-z0-9]{1,10}$/.test(launch.symbol.trim())) return setNotice({ kind: "error", message: "Symbol must be 1–10 letters or numbers." });
    setBusy("create");
    setNotice({ kind: "info", message: "Uploading metadata and building the Pump transaction…" });
    try {
      const uri = await uploadMetadata(launch);
      if (uri.length > 200) throw new Error("Metadata URI is longer than Pump's 200 character limit.");
      const mint = Keypair.generate();
      const global = await sdk.fetchGlobal();
      if (!global.createV2Enabled) throw new Error("Pump create_v2 is currently disabled on-chain.");
      const quoteAmount = launch.initialBuy.trim() ? toBaseUnits(launch.initialBuy, 9) : new BN(0);
      let instructions: TransactionInstruction[];
      if (quoteAmount.isZero()) {
        instructions = [await PUMP_SDK.createV2Instruction({
          mint: mint.publicKey,
          name: launch.name.trim(),
          symbol: launch.symbol.trim().toUpperCase(),
          uri,
          creator: wallet.publicKey,
          user: wallet.publicKey,
          mayhemMode: false,
          holderReward: launch.holderReward,
        })];
      } else {
        const [feeConfig, quoteControl] = await Promise.all([sdk.fetchFeeConfig(), sdk.fetchQuoteControl()]);
        instructions = await PUMP_SDK.createV2AndBuyV2Instructions({
          global,
          mint: mint.publicKey,
          name: launch.name.trim(),
          symbol: launch.symbol.trim().toUpperCase(),
          uri,
          creator: wallet.publicKey,
          user: wallet.publicKey,
          amount: getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: quoteAmount, quoteMint: NATIVE_MINT, quoteControl }),
          quoteAmount,
          mayhemMode: false,
          holderReward: launch.holderReward,
        });
      }
      const signature = await send(instructions, [mint], quoteAmount.isZero() ? 350_000 : 500_000);
      const coin: SavedCoin = {
        mint: mint.publicKey.toBase58(),
        name: launch.name.trim(),
        symbol: launch.symbol.trim().toUpperCase(),
        image: preview || undefined,
        createdAt: Date.now(),
        holderReward: launch.holderReward,
      };
      setCoins(saveCoin(coin));
      setLaunch(initialLaunch);
      setPreview("");
      rememberCreation(coin.mint, signature);
      setNotice(null);
      go(`/token/${coin.mint}?created=1`);
    } catch (error) {
      setNotice({ kind: "error", message: friendlyError(error) });
    } finally {
      setBusy("");
    }
  }

  async function executeTrade(event: FormEvent) {
    event.preventDefault();
    if (route.name !== "token" || !wallet.publicKey || !curve || !quote) return;
    if (curve.bondingCurve.complete) return setNotice({ kind: "error", message: "This curve has graduated. Trade it on PumpSwap." });
    const slip = Number(slippage);
    if (!Number.isFinite(slip) || slip < 0.1 || slip > 25) return setNotice({ kind: "error", message: "Slippage must be between 0.1% and 25%." });
    setBusy("trade");
    try {
      const mint = new PublicKey(route.mint);
      const amount = side === "buy" ? quote : toBaseUnits(tradeAmount, 6);
      const quoteAmount = side === "buy" ? toBaseUnits(tradeAmount, 9) : quote;
      let instructions: TransactionInstruction[];
      if (side === "buy") {
        const fresh = await sdk.fetchBuyState(mint, wallet.publicKey, curve.tokenProgram);
        instructions = await PUMP_SDK.buyV2Instructions({
          global: curve.global, ...fresh, mint, user: wallet.publicKey, amount, quoteAmount, slippage: slip,
          tokenProgram: curve.tokenProgram, quoteTokenProgram: fresh.quoteTokenProgram,
        });
      } else {
        const fresh = await sdk.fetchSellState(mint, wallet.publicKey, curve.tokenProgram);
        instructions = await PUMP_SDK.sellV2Instructions({
          global: curve.global, ...fresh, mint, user: wallet.publicKey, amount, quoteAmount, slippage: slip,
          tokenProgram: curve.tokenProgram, quoteTokenProgram: fresh.quoteTokenProgram,
        });
      }
      const signature = await send(instructions);
      setNotice({ kind: "success", message: `${side === "buy" ? "Buy" : "Sell"} confirmed.`, signature });
      setTradeAmount("");
      setQuote(null);
      await loadCoin(route.mint);
    } catch (error) {
      setNotice({ kind: "error", message: friendlyError(error) });
    } finally {
      setBusy("");
    }
  }

  function openQuery() {
    const value = query.trim();
    try {
      const mint = new PublicKey(value).toBase58();
      setSearchOpen(false);
      setQuery("");
      go(`/token/${mint}`);
      return;
    } catch { /* name search */ }
    const hit = matches[0];
    if (hit) {
      setSearchOpen(false);
      setQuery("");
      go(`/token/${hit.mint}`);
    }
  }

  const saved = route.name === "token" ? coins.find((coin) => coin.mint === route.mint) : undefined;
  const displayName = meta?.name || saved?.name || "Pump coin";
  const displaySymbol = meta?.symbol || saved?.symbol || "TOKEN";
  const displayImage = meta?.image || saved?.image;
  const solQuote = !curve || curve.bondingCurve.quoteMint.equals(NATIVE_MINT) || curve.bondingCurve.quoteMint.equals(PublicKey.default);
  const latestTrade = trades[0];
  const liveReserves = curve && !curve.bondingCurve.virtualTokenReserves.isZero() && !curve.bondingCurve.virtualQuoteReserves.isZero();
  let marketCapSol = 0;
  if (curve && solQuote) {
    try {
      marketCapSol = lamportsToNumber(quoteMarketCap(liveReserves ? curve.bondingCurve : latestTrade ? {
        tokenTotalSupply: curve.bondingCurve.tokenTotalSupply,
        virtualQuoteReserves: latestTrade.virtualSolReserves,
        virtualTokenReserves: latestTrade.virtualTokenReserves,
      } : curve.bondingCurve));
    } catch { marketCapSol = 0; }
  }
  const livePrice = curve ? solPerWholeToken(curve.bondingCurve.virtualQuoteReserves, curve.bondingCurve.virtualTokenReserves) : 0;
  const priceSol = livePrice > 0 ? livePrice : latestTrade ? solPerWholeToken(latestTrade.virtualSolReserves, latestTrade.virtualTokenReserves) : 0;
  const points = chartPoints(
    trades,
    curve?.bondingCurve.virtualQuoteReserves,
    curve?.bondingCurve.virtualTokenReserves,
  );
  const priceChange = points.length >= 2 && points[0].price > 0
    ? ((points[points.length - 1].price - points[0].price) / points[0].price) * 100
    : 0;
  const recentVolume = trades.reduce((sum, trade) => sum.add(trade.solAmount), new BN(0));
  const createdSignature = route.name === "token" ? readCreation(route.mint) : "";
  const progress = curve
    ? Math.min(100, Math.max(0, 100 * (1 - curve.bondingCurve.realTokenReserves.toNumber() / Math.max(1, curve.global.initialRealTokenReserves.toNumber()))))
    : 0;

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => go("/")}><Mark /> <span>StonkLab</span></button>
        <nav className="nav">
          <button className={route.name === "home" ? "active" : ""} onClick={() => go("/")}>Board</button>
          <button className={route.name === "launch" ? "active" : ""} onClick={() => go("/launch")}>Launch</button>
        </nav>
        <div className="spacer" />
        <button className="search-btn" onClick={() => setSearchOpen(true)}><Search size={15} /> Search a mint <kbd>Ctrl K</kbd></button>
        <button className="search-icon" onClick={() => setSearchOpen(true)} aria-label="Search a mint"><Search size={16} /></button>
        <button className="launch-btn" onClick={() => go("/launch")}>Launch token</button>
        <button className={`connect-btn ${wallet.publicKey ? "live" : ""}`} onClick={() => wallet.publicKey ? wallet.disconnect() : setVisible(true)}>
          {wallet.publicKey ? shortAddress(wallet.publicKey.toBase58(), 4) : "Connect"}
        </button>
      </header>

      <main className="page">
        {route.name === "home" && (
          <>
            <section className="hero">
              <h1>Launch coins paired with SOL.</h1>
              <p>Create a real Token-2022 coin and its Pump bonding curve, then buy and sell it from the same board. Your wallet signs every mainnet transaction.</p>
              <button className="launch-btn" onClick={() => go("/launch")}>Launch a token</button>
            </section>
            <div className="toolbar">
              <div>
                <h2>Sort</h2>
                <div className="chips">
                  <button className={`chip ${sort === "newest" ? "active" : ""}`} onClick={() => setSort("newest")}>Newest</button>
                  <button className={`chip ${sort === "name" ? "active" : ""}`} onClick={() => setSort("name")}>Name</button>
                </div>
              </div>
              <div>
                <h2>Paired with</h2>
                <div className="chips">
                  {QUOTES.map((quoteName) => (
                    <button key={quoteName} className={`chip ${quoteName === "Solana" ? "active" : ""}`} disabled={quoteName !== "Solana"}>{quoteName}</button>
                  ))}
                </div>
              </div>
            </div>
            <h2 className="section-label">All tokens</h2>
            <div className="grid">
              {shown.length === 0 && (
                <div className="empty card">
                  <div><b>No coins on this board yet</b><span>Launch one, or search any Pump mint address to trade it.</span></div>
                </div>
              )}
              {shown.map((coin) => (
                <button key={coin.mint} className="card" onClick={() => go(`/token/${coin.mint}`)}>
                  <div className="thumb">{coin.image ? <img src={coin.image} alt="" /> : coin.symbol.slice(0, 2)}</div>
                  <div className="card-top"><div><b>${coin.symbol}</b><small>{coin.name}</small></div><span className="tag">SOL</span></div>
                  <div className="card-foot">
                    <span>{caps[coin.mint] ? (caps[coin.mint] === "Graduated" ? "Graduated" : `${caps[coin.mint]} mcap`) : "Bonding curve"}</span>
                    <span>{coin.holderReward ? "Holder rewards" : shortAddress(coin.mint, 4)}</span>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {route.name === "launch" && (
          <section className="launch-layout">
            <form id="launch-form" onSubmit={createToken}>
              <div className="launch-copy">
                <h1>Launch a token</h1>
                <p>Create a fixed-supply token and a one-sided Pump bonding curve quoted in SOL. The coin exists on Solana mainnet as soon as your wallet confirms.</p>
              </div>
              <div className="panel">
                <div className="kicker">Creator fee</div>
                <div className="fee-row">
                  <button type="button" className={`fee ${launch.holderReward ? "" : "active"}`} onClick={() => setLaunch({ ...launch, holderReward: false })}><strong>Standard</strong><span>Creator fees can be collected</span></button>
                  <button type="button" className={`fee ${launch.holderReward ? "active" : ""}`} onClick={() => setLaunch({ ...launch, holderReward: true })}><strong>Holders</strong><span>Fees are reserved for holders</span></button>
                </div>
                <p className="help">{launch.holderReward ? "Holder rewards are permanent. Pump distributes the creator fee to holders instead of a creator wallet." : "The normal Pump fee schedule applies. Protocol and creator fees are charged by the program on every trade."}</p>
              </div>
              <div className="panel" style={{ marginTop: 12 }}>
                <div className="two">
                  <label className="field"><span>Token name <i>{launch.name.length}/32</i></span><input required maxLength={32} value={launch.name} placeholder="e.g. Moon Cat" onChange={(event) => setLaunch({ ...launch, name: event.target.value })} /></label>
                  <label className="field"><span>Symbol <i>{launch.symbol.length}/10</i></span><input required maxLength={10} value={launch.symbol} placeholder="e.g. MOON" onChange={(event) => setLaunch({ ...launch, symbol: event.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() })} /></label>
                </div>
                <label className="field"><span>Description <i>optional</i></span><textarea maxLength={500} value={launch.description} placeholder="What should traders know?" onChange={(event) => setLaunch({ ...launch, description: event.target.value })} /></label>
                <label className="drop">
                  {preview ? <img src={preview} alt="Token artwork" /> : <><ImagePlus size={22} /><b>Token image</b><small>Square PNG, JPEG or WebP, up to 2 MB</small></>}
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    if (file && file.size > 2_000_000) return setNotice({ kind: "error", message: "Image must be 2 MB or smaller." });
                    setLaunch({ ...launch, image: file });
                    setPreview(file ? URL.createObjectURL(file) : "");
                  }} />
                </label>
                <div className="kicker" style={{ marginTop: 18 }}>Project links</div>
                <p className="help" style={{ marginTop: 0 }}>Optional. Saved in the token metadata.</p>
                <div className="two">
                  <label className="field"><span>Website</span><input value={launch.website} placeholder="https://" onChange={(event) => setLaunch({ ...launch, website: event.target.value })} /></label>
                  <label className="field"><span>X / Twitter</span><input value={launch.twitter} placeholder="https://x.com/…" onChange={(event) => setLaunch({ ...launch, twitter: event.target.value })} /></label>
                </div>
                <label className="field"><span>Telegram</span><input value={launch.telegram} placeholder="https://t.me/…" onChange={(event) => setLaunch({ ...launch, telegram: event.target.value })} /></label>
                <label className="field"><span>Metadata URI <i>skips the upload</i></span><input value={launch.metadataUri} placeholder="ipfs://… or https://…" onChange={(event) => setLaunch({ ...launch, metadataUri: event.target.value })} /></label>
              </div>
              <div className="panel" style={{ marginTop: 12 }}>
                <div className="kicker">Quote token</div>
                <p className="help" style={{ marginTop: 0 }}>The new coin trades against this asset on its bonding curve.</p>
                <div className="chips" style={{ marginTop: 10 }}>
                  {QUOTES.map((quoteName) => <button key={quoteName} type="button" className={`chip ${quoteName === "Solana" ? "active" : ""}`} disabled={quoteName !== "Solana"}>{quoteName} {quoteName === "Solana" ? "1" : "0"}</button>)}
                </div>
                <div className="card" style={{ marginTop: 12, cursor: "default" }}><b>SOL</b><small>Native Solana. Pump creates the curve and trades it through buy_v2 and sell_v2.</small></div>
                <label className="field"><span>Optional first buy <i>bundled into creation</i></span><input inputMode="decimal" value={launch.initialBuy} placeholder="0.00" onChange={(event) => setLaunch({ ...launch, initialBuy: event.target.value })} /></label>
              </div>
            </form>
            <aside className="panel summary">
              <div className="kicker">Launch summary</div>
              <div className="rows">
                <div><span>Supply</span><b>{supplyLabel}</b></div>
                <div><span>Quote</span><b>SOL</b></div>
                <div><span>Market</span><b>Pump bonding curve</b></div>
                <div><span>Creator fee</span><b>{launch.holderReward ? "Holder rewards" : "Standard"}</b></div>
                <div><span>First buy</span><b>{launch.initialBuy.trim() || "0"} SOL</b></div>
                <div><span>Network</span><b>Solana mainnet</b></div>
              </div>
              <label className="check"><input type="checkbox" checked={launch.accepted} onChange={(event) => setLaunch({ ...launch, accepted: event.target.checked })} /><span>I understand this uses real SOL, creation is irreversible, and the token can lose all of its value.</span></label>
              <button className="primary" form="launch-form" disabled={busy === "create"}>{busy === "create" ? <><LoaderCircle className="spin" size={16} /> Creating…</> : wallet.publicKey ? "Create token" : "Connect wallet"}</button>
              <p className="fine">Image and metadata are uploaded before signing. Account rent and the network fee are paid from your wallet. This is an independent Pump interface, not Pump itself.</p>
            </aside>
          </section>
        )}

        {route.name === "token" && (
          <section className="token-layout">
            <div className="token-main">
              <button className="text-btn" onClick={() => go("/")}>← Board</button>
              {route.created && (
                <section className="confirm">
                  <div className="live-pill"><i /> Live on Solana mainnet</div>
                  <h2>{createdSignature ? "Your token is live" : "This token is live"}</h2>
                  <p>{displayName} has a Pump bonding curve. Copy the contract address or the buy link and share it.</p>
                  <ShareRows mint={route.mint} />
                  <div className="confirm-actions">
                    <a className="ghost" href={`${EXPLORER}/token/${route.mint}`} target="_blank" rel="noreferrer">View contract</a>
                    {createdSignature && <a className="ghost" href={`${EXPLORER}/tx/${createdSignature}`} target="_blank" rel="noreferrer">Creation tx</a>}
                    <button type="button" className="primary" onClick={() => go(`/token/${route.mint}`)}>Trade this token</button>
                  </div>
                </section>
              )}
              <div className="token-head">
                {displayImage ? <img src={displayImage} alt="" /> : <div className="token-fallback">{displaySymbol.slice(0, 2)}</div>}
                <div>
                  <h1>{displayName}</h1>
                  <p>${displaySymbol} · paired with SOL {(curve?.bondingCurve.isHolderReward || saved?.holderReward) ? "· holder rewards" : ""}</p>
                  {meta?.description && <p className="token-desc">{meta.description}</p>}
                </div>
              </div>
              <div className="stats">
                <div className="stat">
                  <span>{curve?.bondingCurve.complete ? "Curve mcap" : "Market cap"}</span>
                  <b>{curve && solQuote ? `${formatSolNumber(marketCapSol)} SOL` : curve ? "Other quote" : "—"}</b>
                  {solUsd > 0 && marketCapSol > 0 && <small>{formatUsd(marketCapSol * solUsd)}</small>}
                </div>
                <div className="stat">
                  <span>{curve?.bondingCurve.complete ? "Last price" : "Price"}</span>
                  <b>{curve ? `${formatSolNumber(priceSol)} SOL` : "—"}</b>
                  {solUsd > 0 && priceSol > 0 && <small>{formatUsd(priceSol * solUsd)}</small>}
                </div>
                <div className="stat">
                  <span>Curve</span>
                  <b>{curve ? `${progress.toFixed(1)}%` : "—"}</b>
                  <small>{curve?.bondingCurve.complete ? "Graduated" : "Bonding curve"}</small>
                </div>
                <div className="stat">
                  <span>Recent volume</span>
                  <b>{historyState === "ready" ? `${fromBaseUnits(recentVolume, 9, 3)} SOL` : "—"}</b>
                  <small>{trades.length} shown trades</small>
                </div>
              </div>
              <div className="panel chart-panel">
                <div className="chart-head">
                  <div>
                    <div className="kicker">Trading chart</div>
                    <strong>{curve ? `${formatSolNumber(priceSol)} SOL` : "Loading price"}</strong>
                  </div>
                  {trades.length >= 2 && points[0]?.price > 0 && (
                    <b className={priceChange >= 0 ? "up" : "down"}>{priceChange >= 0 ? "+" : ""}{priceChange.toFixed(2)}%</b>
                  )}
                </div>
                <div className="chart-wrap"><PriceChart points={points} /></div>
                <p className="fine">Each point is the SOL price after a buy or sell on this bonding curve.</p>
              </div>
              <div className="panel">
                {busy === "load" && !curve ? <p className="muted">Reading the bonding curve…</p> : curve ? (
                  <>
                    <div className="field-head"><span>Bonding curve</span><b>{progress.toFixed(1)}%</b></div>
                    <div className="progress"><i style={{ width: `${progress}%` }} /></div>
                    <p className="fine">{curve.bondingCurve.complete ? "This curve is complete and has graduated." : `${fromBaseUnits(curve.bondingCurve.realTokenReserves, 6, 0)} tokens remain on the curve.`}</p>
                  </>
                ) : <p className="muted">Curve data will appear here after it loads.</p>}
              </div>
              <div className="panel">
                <div className="kicker">Buy and sell history</div>
                {historyState === "loading" && <p className="muted">Loading recent trades…</p>}
                {historyState === "error" && <p className="muted">Trade history could not be loaded. The price and market cap above still come from the live curve.</p>}
                {historyState === "ready" && trades.length === 0 && <p className="muted">No buys or sells yet. The first trade will show up here.</p>}
                {trades.length > 0 && (
                  <div className="trades-scroll">
                    <table className="trades">
                      <thead>
                        <tr><th>Side</th><th>SOL</th><th>Tokens</th><th>Trader</th><th>Time</th><th></th></tr>
                      </thead>
                      <tbody>
                        {trades.map((trade) => (
                          <tr key={`${trade.signature}-${trade.timestamp}-${trade.solAmount.toString()}`}>
                            <td className={trade.isBuy ? "side-buy" : "side-sell"}>{trade.isBuy ? "Buy" : "Sell"}</td>
                            <td>{fromBaseUnits(trade.solAmount, 9, 4)}</td>
                            <td>{fromBaseUnits(trade.tokenAmount, 6, 2)}</td>
                            <td className="mono">{shortAddress(trade.user, 4)}</td>
                            <td>{relTime(trade.timestamp)}</td>
                            <td><a href={`${EXPLORER}/tx/${trade.signature}`} target="_blank" rel="noreferrer">Tx</a></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="panel">
                <div className="kicker">Contract and buy link</div>
                <ShareRows mint={route.mint} />
                <p className="fine">Anyone with the buy link can open this coin, see the chart, and trade it from a connected wallet.</p>
              </div>
            </div>
            <form className="panel trade-card" onSubmit={executeTrade}>
              <div className="sides">
                <button type="button" className={side === "buy" ? "on-buy" : ""} onClick={() => { setSide("buy"); setTradeAmount(""); setQuote(null); }}>Buy</button>
                <button type="button" className={side === "sell" ? "on-sell" : ""} onClick={() => { setSide("sell"); setTradeAmount(""); setQuote(null); }}>Sell</button>
              </div>
              <label className="field"><span>{side === "buy" ? "You pay" : "You sell"}</span>
                <div className="amount"><input inputMode="decimal" value={tradeAmount} placeholder="0.00" onChange={(event) => { setTradeAmount(event.target.value); quoteTrade(event.target.value, side); }} /><b>{side === "buy" ? "SOL" : "TOKEN"}</b></div>
              </label>
              {side === "sell" && curve && <button type="button" className="linkish" onClick={() => { const max = fromBaseUnits(curve.balance, 6, 6).replace(/,/g, ""); setTradeAmount(max); quoteTrade(max, "sell"); }}>Balance {fromBaseUnits(curve.balance, 6, 2)} · Max</button>}
              <div className="quote-line"><span>Estimated received</span><b>{quote ? `${fromBaseUnits(quote, side === "buy" ? 6 : 9, 6)} ${side === "buy" ? "tokens" : "SOL"}` : "—"}</b></div>
              <label className="field"><span>Slippage tolerance</span><input inputMode="decimal" value={slippage} onChange={(event) => setSlippage(event.target.value)} /></label>
              <button className="primary" style={{ marginTop: 14 }} disabled={busy === "trade" || !quote || Boolean(curve?.bondingCurve.complete)}>{curve?.bondingCurve.complete ? "Curve graduated" : busy === "trade" ? "Confirming…" : wallet.publicKey ? `${side === "buy" ? "Buy" : "Sell"} on curve` : "Connect wallet"}</button>
              {!wallet.publicKey && !curve?.bondingCurve.complete && <button type="button" className="ghost" style={{ width: "100%", marginTop: 8 }} onClick={() => setVisible(true)}>Connect</button>}
            </form>
          </section>
        )}
      </main>

      <footer className="foot">
        <span>StonkLab · independent Pump interface</span>
        <div>
          <a href="https://github.com/pump-fun/pump-public-docs" target="_blank" rel="noreferrer">Protocol docs</a>
          <a href="https://solscan.io" target="_blank" rel="noreferrer">Solscan</a>
          <span>Mainnet only</span>
        </div>
      </footer>

      {searchOpen && (
        <div className="modal-back" onClick={() => setSearchOpen(false)}>
          <form className="modal" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); openQuery(); }}>
            <input autoFocus value={query} placeholder="Paste a mint address or search your coins" onChange={(event) => setQuery(event.target.value)} />
            {query.trim() && matches.slice(0, 6).map((coin) => (
              <button key={coin.mint} type="button" className="result" onClick={() => { setSearchOpen(false); setQuery(""); go(`/token/${coin.mint}`); }}>
                <b>${coin.symbol}</b> {coin.name}<br /><small className="muted">{shortAddress(coin.mint, 6)}</small>
              </button>
            ))}
            <p className="fine">A valid mint opens that Pump coin directly, even if it was not launched here.</p>
          </form>
        </div>
      )}

      {notice && (
        <div className={`notice ${notice.kind}`}>
          {notice.kind === "info" && <LoaderCircle className="spin" size={16} />}
          <span>{notice.message}</span>
          {notice.signature && <a href={`${EXPLORER}/tx/${notice.signature}`} target="_blank" rel="noreferrer">View tx</a>}
          <button onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}
    </div>
  );
}
