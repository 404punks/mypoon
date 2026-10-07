import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
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
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import {
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  OnlinePumpSdk,
  PUMP_SDK,
} from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { ImagePlus, LoaderCircle, Search } from "lucide-react";

type Route = { name: "home" } | { name: "launch" } | { name: "token"; mint: string };
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
  const path = location.hash.replace(/^#/, "") || "/";
  if (path.startsWith("/launch")) return { name: "launch" };
  if (path.startsWith("/token/")) return { name: "token", mint: decodeURIComponent(path.slice("/token/".length)) };
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

function saveCoin(coin: SavedCoin) {
  const next = [coin, ...readCoins().filter((item) => item.mint !== coin.mint)].slice(0, 48);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next.map((item) => ({
    ...item,
    image: item.image?.startsWith("blob:") ? undefined : item.image,
  }))));
  return next;
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
  const response = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: payload });
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
      const [global, feeConfig, state, supplyResult] = await Promise.all([
        sdk.fetchGlobal(),
        sdk.fetchFeeConfig(),
        sdk.fetchBuyState(mint, user, mintAccount.owner),
        connection.getTokenSupply(mint),
      ]);
      const ata = await getAssociatedTokenAddress(mint, user, true, mintAccount.owner);
      const balance = wallet.publicKey
        ? await connection.getTokenAccountBalance(ata).catch(() => null)
        : null;
      setCurve({
        ...state,
        tokenProgram: mintAccount.owner,
        supply: new BN(supplyResult.value.amount),
        balance: new BN(balance?.value.amount ?? 0),
        global,
        feeConfig,
      });
    } catch (error) {
      setCurve(null);
      setNotice({ kind: "error", message: friendlyError(error) });
    } finally {
      setBusy("");
    }
  }, [connection, sdk, wallet.publicKey]);

  useEffect(() => {
    if (route.name !== "token") return;
    setTradeAmount("");
    setQuote(null);
    setSide("buy");
    void loadCoin(route.mint);
  }, [loadCoin, route]);

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
      setNotice({ kind: "success", message: "Token and bonding curve are live on Solana mainnet.", signature });
      go(`/token/${coin.mint}`);
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
                  <small>{coin.holderReward ? "Holder rewards" : "Standard"} · {shortAddress(coin.mint, 4)}</small>
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
            <div>
              <button className="text-btn" onClick={() => go("/")}>← Board</button>
              <div className="token-head" style={{ marginTop: 12 }}>
                {saved?.image ? <img src={saved.image} alt="" /> : <div className="token-fallback">{(saved?.symbol || "SOL").slice(0, 2)}</div>}
                <div>
                  <h1>{saved?.name || "Pump coin"}</h1>
                  <p>${saved?.symbol || "TOKEN"} · paired with SOL {saved?.holderReward ? "· holder rewards" : ""}</p>
                  <a className="addr" href={`${EXPLORER}/token/${route.mint}`} target="_blank" rel="noreferrer">{shortAddress(route.mint, 8)}</a>
                </div>
              </div>
              <div className="panel" style={{ marginTop: 16 }}>
                {busy === "load" && !curve ? <p className="muted">Reading the bonding curve…</p> : curve ? (
                  <>
                    <div className="field-head"><span>Bonding curve</span><b>{progress.toFixed(1)}%</b></div>
                    <div className="progress"><i style={{ width: `${progress}%` }} /></div>
                    <p className="fine">{curve.bondingCurve.complete ? "This curve is complete and has graduated." : `${fromBaseUnits(curve.bondingCurve.realTokenReserves, 6, 0)} tokens remain on the curve.`}</p>
                  </>
                ) : <p className="muted">Curve data will appear here after it loads.</p>}
              </div>
            </div>
            <form className="panel" onSubmit={executeTrade}>
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
              <button className="primary" style={{ marginTop: 14 }} disabled={busy === "trade" || !quote || Boolean(curve?.bondingCurve.complete)}>{busy === "trade" ? "Confirming…" : wallet.publicKey ? `${side === "buy" ? "Buy" : "Sell"} on curve` : "Connect wallet"}</button>
              {!wallet.publicKey && <button type="button" className="ghost" style={{ width: "100%", marginTop: 8 }} onClick={() => setVisible(true)}>Connect</button>}
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
