import { FormEvent, useCallback, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
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
import {
  ArrowDownUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  Coins,
  Copy,
  ExternalLink,
  ImagePlus,
  Info,
  LoaderCircle,
  LockKeyhole,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
  Wallet,
  Zap,
} from "lucide-react";

type Tab = "launch" | "trade" | "learn";
type Side = "buy" | "sell";
type Notice = { kind: "success" | "error" | "info"; message: string; signature?: string };
type CurveState = Awaited<ReturnType<OnlinePumpSdk["fetchBuyState"]>> & {
  tokenProgram: PublicKey;
  supply: BN;
  balance: BN;
  global: Awaited<ReturnType<OnlinePumpSdk["fetchGlobal"]>>;
  feeConfig: Awaited<ReturnType<OnlinePumpSdk["fetchFeeConfig"]>>;
};

const EXPLORER = "https://solscan.io";
const TOKEN_DECIMALS = 6;

function toBaseUnits(value: string, decimals: number): BN {
  const normalized = value.trim();
  if (!/^\d*(\.\d*)?$/.test(normalized) || !normalized || Number(normalized) < 0) {
    throw new Error("Enter a valid positive amount.");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) throw new Error(`Use no more than ${decimals} decimal places.`);
  return new BN((whole || "0") + fraction.padEnd(decimals, "0"));
}

function fromBaseUnits(value: BN, decimals: number, precision = 4) {
  const padded = value.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const fraction = padded.slice(-decimals).slice(0, precision).replace(/0+$/, "");
  return `${Number(whole).toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}

function shortAddress(value: string, size = 4) {
  return `${value.slice(0, size)}…${value.slice(-size)}`;
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("User rejected")) return "Transaction cancelled in your wallet.";
  if (message.includes("Attempt to debit")) return "Your wallet does not have enough SOL.";
  if (message.includes("429")) return "The public RPC is busy. Add a private mainnet RPC in VITE_SOLANA_RPC_URL.";
  return message.replace(/^Error: /, "").slice(0, 260);
}

async function uploadMetadata(form: LaunchForm) {
  if (form.metadataUri.trim()) return form.metadataUri.trim();
  if (!form.image) throw new Error("Add a token image or provide a metadata URI.");
  const payload = new FormData();
  payload.append("file", form.image);
  payload.append("name", form.name.trim());
  payload.append("symbol", form.symbol.trim().toUpperCase());
  payload.append("description", form.description.trim());
  payload.append("twitter", form.twitter.trim());
  payload.append("telegram", form.telegram.trim());
  payload.append("website", form.website.trim());
  payload.append("showName", "true");
  const response = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: payload });
  if (!response.ok) throw new Error(`Metadata upload failed (${response.status}). Try a metadata URI instead.`);
  const result = (await response.json()) as { metadataUri?: string };
  if (!result.metadataUri) throw new Error("Metadata service did not return a URI.");
  return result.metadataUri;
}

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

export default function App() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [tab, setTab] = useState<Tab>("launch");
  const [launch, setLaunch] = useState<LaunchForm>(initialLaunch);
  const [imagePreview, setImagePreview] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [createdMint, setCreatedMint] = useState("");
  const [mintInput, setMintInput] = useState("");
  const [curve, setCurve] = useState<CurveState | null>(null);
  const [side, setSide] = useState<Side>("buy");
  const [tradeAmount, setTradeAmount] = useState("");
  const [slippage, setSlippage] = useState("1");
  const [quote, setQuote] = useState<BN | null>(null);

  const sdk = useMemo(() => new OnlinePumpSdk(connection), [connection]);

  const send = useCallback(
    async (instructions: TransactionInstruction[], signers: Keypair[] = [], units = 400_000) => {
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
      const signature = await wallet.sendTransaction(transaction, connection, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction({ signature, ...latest }, "confirmed");
      return signature;
    },
    [connection, wallet],
  );

  async function createToken(event: FormEvent) {
    event.preventDefault();
    if (!wallet.publicKey) return setNotice({ kind: "error", message: "Connect a Solana wallet first." });
    if (!launch.accepted) return setNotice({ kind: "error", message: "Confirm the mainnet risk notice." });
    if (!launch.name.trim() || launch.name.length > 32) return setNotice({ kind: "error", message: "Name must be 1–32 characters." });
    if (!launch.symbol.trim() || launch.symbol.length > 13) return setNotice({ kind: "error", message: "Ticker must be 1–13 characters." });

    setBusy("create");
    setNotice({ kind: "info", message: "Uploading metadata and preparing your Pump transaction…" });
    try {
      const uri = await uploadMetadata(launch);
      if (uri.length > 200) throw new Error("Metadata URI exceeds Pump's 200 character limit.");
      const mint = Keypair.generate();
      const global = await sdk.fetchGlobal();
      if (!global.createV2Enabled) throw new Error("Pump create_v2 is currently disabled on-chain.");
      const quoteAmount = launch.initialBuy ? toBaseUnits(launch.initialBuy, 9) : new BN(0);
      let instructions: TransactionInstruction[];
      if (quoteAmount.isZero()) {
        instructions = [
          await PUMP_SDK.createV2Instruction({
            mint: mint.publicKey,
            name: launch.name.trim(),
            symbol: launch.symbol.trim().toUpperCase(),
            uri,
            creator: wallet.publicKey,
            user: wallet.publicKey,
            mayhemMode: false,
            holderReward: launch.holderReward,
          }),
        ];
      } else {
        const [feeConfig, quoteControl] = await Promise.all([
          sdk.fetchFeeConfig(),
          sdk.fetchQuoteControl(),
        ]);
        const amount = getBuyTokenAmountFromSolAmount({
          global,
          feeConfig,
          mintSupply: null,
          bondingCurve: null,
          amount: quoteAmount,
          quoteMint: NATIVE_MINT,
          quoteControl,
        });
        instructions = await PUMP_SDK.createV2AndBuyV2Instructions({
          global,
          mint: mint.publicKey,
          name: launch.name.trim(),
          symbol: launch.symbol.trim().toUpperCase(),
          uri,
          creator: wallet.publicKey,
          user: wallet.publicKey,
          amount,
          quoteAmount,
          mayhemMode: false,
          holderReward: launch.holderReward,
        });
      }
      const signature = await send(instructions, [mint], quoteAmount.isZero() ? 350_000 : 500_000);
      setCreatedMint(mint.publicKey.toBase58());
      setMintInput(mint.publicKey.toBase58());
      setNotice({ kind: "success", message: "Your token and bonding curve are live on Solana mainnet.", signature });
    } catch (error) {
      setNotice({ kind: "error", message: friendlyError(error) });
    } finally {
      setBusy("");
    }
  }

  const loadCoin = useCallback(async () => {
    if (!wallet.publicKey) return setNotice({ kind: "error", message: "Connect your wallet to load balances." });
    setBusy("load");
    setNotice(null);
    setCurve(null);
    setQuote(null);
    try {
      const mint = new PublicKey(mintInput.trim());
      const mintAccount = await connection.getAccountInfo(mint);
      if (!mintAccount || (!mintAccount.owner.equals(TOKEN_PROGRAM_ID) && !mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID))) {
        throw new Error("This is not a valid SPL token mint.");
      }
      const tokenProgram = mintAccount.owner;
      const [global, feeConfig, state, supplyResult] = await Promise.all([
        sdk.fetchGlobal(),
        sdk.fetchFeeConfig(),
        sdk.fetchBuyState(mint, wallet.publicKey, tokenProgram),
        connection.getTokenSupply(mint),
      ]);
      const ata = await getAssociatedTokenAddress(mint, wallet.publicKey, true, tokenProgram);
      const balanceResult = await connection.getTokenAccountBalance(ata).catch(() => null);
      setCurve({
        ...state,
        tokenProgram,
        supply: new BN(supplyResult.value.amount),
        balance: new BN(balanceResult?.value.amount ?? 0),
        global,
        feeConfig,
      });
    } catch (error) {
      setNotice({ kind: "error", message: friendlyError(error) });
    } finally {
      setBusy("");
    }
  }, [connection, mintInput, sdk, wallet.publicKey]);

  function calculateQuote(value = tradeAmount, selectedSide = side) {
    if (!curve || !value) return setQuote(null);
    try {
      if (selectedSide === "buy") {
        const quoteAmount = toBaseUnits(value, 9);
        setQuote(
          getBuyTokenAmountFromSolAmount({
            global: curve.global,
            feeConfig: curve.feeConfig,
            mintSupply: curve.supply,
            bondingCurve: curve.bondingCurve,
            amount: quoteAmount,
            quoteMint: curve.quoteMint,
          }),
        );
      } else {
        const amount = toBaseUnits(value, TOKEN_DECIMALS);
        setQuote(
          getSellSolAmountFromTokenAmount({
            global: curve.global,
            feeConfig: curve.feeConfig,
            mintSupply: curve.supply,
            bondingCurve: curve.bondingCurve,
            amount,
          }),
        );
      }
    } catch {
      setQuote(null);
    }
  }

  async function executeTrade(event: FormEvent) {
    event.preventDefault();
    if (!wallet.publicKey || !curve || !quote) return;
    if (curve.bondingCurve.complete) return setNotice({ kind: "error", message: "This bonding curve has graduated. Trade it on PumpSwap." });
    const slip = Number(slippage);
    if (!Number.isFinite(slip) || slip < 0.1 || slip > 25) return setNotice({ kind: "error", message: "Slippage must be between 0.1% and 25%." });
    setBusy("trade");
    setNotice({ kind: "info", message: `Preparing ${side} transaction…` });
    try {
      const mint = new PublicKey(mintInput.trim());
      const amount = side === "buy" ? quote : toBaseUnits(tradeAmount, TOKEN_DECIMALS);
      const quoteAmount = side === "buy" ? toBaseUnits(tradeAmount, 9) : quote;
      let instructions: TransactionInstruction[];
      if (side === "buy") {
        const fresh = await sdk.fetchBuyState(mint, wallet.publicKey, curve.tokenProgram);
        instructions = await PUMP_SDK.buyV2Instructions({
            global: curve.global,
            ...fresh,
            mint,
            user: wallet.publicKey,
            amount,
            quoteAmount,
            slippage: slip,
            tokenProgram: curve.tokenProgram,
            quoteTokenProgram: fresh.quoteTokenProgram,
          });
      } else {
        const fresh = await sdk.fetchSellState(mint, wallet.publicKey, curve.tokenProgram);
        instructions = await PUMP_SDK.sellV2Instructions({
            global: curve.global,
            ...fresh,
            mint,
            user: wallet.publicKey,
            amount,
            quoteAmount,
            slippage: slip,
            tokenProgram: curve.tokenProgram,
            quoteTokenProgram: fresh.quoteTokenProgram,
          });
      }
      const signature = await send(instructions, [], 400_000);
      setNotice({ kind: "success", message: `${side === "buy" ? "Buy" : "Sell"} confirmed on Solana.`, signature });
      setTradeAmount("");
      setQuote(null);
      await loadCoin();
    } catch (error) {
      setNotice({ kind: "error", message: friendlyError(error) });
    } finally {
      setBusy("");
    }
  }

  const progress = curve
    ? Math.min(100, Math.max(0, 100 * (1 - curve.bondingCurve.realTokenReserves.toNumber() / curve.global.initialRealTokenReserves.toNumber())))
    : 0;

  return (
    <div className="app-shell">
      <div className="noise" />
      <header>
        <button className="brand" onClick={() => setTab("launch")}>
          <span className="brand-mark"><ArrowUpRight size={22} /></span>
          <span>curvelab<span className="brand-dot">.</span></span>
        </button>
        <nav>
          {(["launch", "trade", "learn"] as Tab[]).map((item) => (
            <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
              {item}
            </button>
          ))}
        </nav>
        <div className="header-right">
          <span className="network"><i /> mainnet</span>
          <WalletMultiButton />
        </div>
      </header>

      <main>
        {notice && (
          <div className={`notice ${notice.kind}`}>
            {notice.kind === "success" ? <Check size={18} /> : notice.kind === "error" ? <CircleAlert size={18} /> : <LoaderCircle className="spin" size={18} />}
            <span>{notice.message}</span>
            {notice.signature && <a href={`${EXPLORER}/tx/${notice.signature}`} target="_blank" rel="noreferrer">view tx <ExternalLink size={13} /></a>}
            <button onClick={() => setNotice(null)}>×</button>
          </div>
        )}

        {tab === "launch" && (
          <>
            <section className="hero">
              <div>
                <span className="eyebrow"><Sparkles size={14} /> permissionless token launch</span>
                <h1>Turn an idea into<br /><em>an on-chain market.</em></h1>
                <p>Create a Token-2022 coin and its Pump bonding curve in one wallet transaction. No code. No presale. No private keys.</p>
              </div>
              <div className="hero-stamp">
                <ShieldCheck size={38} />
                <b>PUMP<br />PROTOCOL</b>
                <small>SOLANA MAINNET</small>
              </div>
            </section>

            <section className="launch-grid">
              <form className="panel launch-form" onSubmit={createToken}>
                <div className="panel-head">
                  <div><span>01</span><h2>Launch your coin</h2></div>
                  <span className="secure"><LockKeyhole size={13} /> wallet signs locally</span>
                </div>
                <div className="form-content">
                  <label className="image-drop">
                    {imagePreview ? <img src={imagePreview} alt="Token preview" /> : <><ImagePlus size={28} /><b>Add token image</b><small>Square PNG, JPG or GIF · max 5MB</small></>}
                    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      if (file && file.size > 5_000_000) return setNotice({ kind: "error", message: "Image must be under 5MB." });
                      setLaunch({ ...launch, image: file });
                      setImagePreview(file ? URL.createObjectURL(file) : "");
                    }} />
                    {imagePreview && <span className="change-image"><Upload size={12} /> replace</span>}
                  </label>
                  <div className="field-row">
                    <label><span>Token name</span><input required maxLength={32} value={launch.name} onChange={(e) => setLaunch({ ...launch, name: e.target.value })} placeholder="e.g. Moon Cat" /><small>{launch.name.length}/32</small></label>
                    <label><span>Ticker</span><div className="prefix-input"><b>$</b><input required maxLength={13} value={launch.symbol} onChange={(e) => setLaunch({ ...launch, symbol: e.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() })} placeholder="MOON" /></div><small>{launch.symbol.length}/13</small></label>
                  </div>
                  <label><span>Description</span><textarea maxLength={500} value={launch.description} onChange={(e) => setLaunch({ ...launch, description: e.target.value })} placeholder="What makes your coin memorable?" /><small>{launch.description.length}/500</small></label>
                  <div className="field-row">
                    <label><span>Website <i>optional</i></span><input type="url" value={launch.website} onChange={(e) => setLaunch({ ...launch, website: e.target.value })} placeholder="https://" /></label>
                    <label><span>X / Twitter <i>optional</i></span><input value={launch.twitter} onChange={(e) => setLaunch({ ...launch, twitter: e.target.value })} placeholder="https://x.com/…" /></label>
                  </div>
                  <details>
                    <summary>Advanced options <ChevronRight size={15} /></summary>
                    <div className="advanced">
                      <label><span>Telegram <i>optional</i></span><input value={launch.telegram} onChange={(e) => setLaunch({ ...launch, telegram: e.target.value })} placeholder="https://t.me/…" /></label>
                      <label><span>Existing metadata URI</span><input value={launch.metadataUri} onChange={(e) => setLaunch({ ...launch, metadataUri: e.target.value })} placeholder="ipfs://… (skips image upload)" /></label>
                      <label className="check-line"><input type="checkbox" checked={launch.holderReward} onChange={(e) => setLaunch({ ...launch, holderReward: e.target.checked })} /><span><b>Holder rewards coin</b><small>Creator trading fees are distributed by Pump to eligible holders. This choice is permanent.</small></span></label>
                    </div>
                  </details>
                  <div className="initial-buy">
                    <div><Zap size={18} /><span><b>Optional first buy</b><small>Bundle a buy with creation to seed your position.</small></span></div>
                    <label><input inputMode="decimal" value={launch.initialBuy} onChange={(e) => setLaunch({ ...launch, initialBuy: e.target.value })} placeholder="0.00" /><b>SOL</b></label>
                  </div>
                  <label className="check-line risk"><input type="checkbox" checked={launch.accepted} onChange={(e) => setLaunch({ ...launch, accepted: e.target.checked })} /><span>I understand this uses real SOL on mainnet and token creation is irreversible.</span></label>
                  <button className="primary" disabled={busy === "create"}>
                    {busy === "create" ? <><LoaderCircle className="spin" size={18} /> Preparing transaction…</> : <><Rocket size={18} /> Create coin on mainnet <ChevronRight size={18} /></>}
                  </button>
                </div>
              </form>

              <aside>
                {createdMint && <div className="success-card"><span><Check size={18} /></span><div><b>Coin created</b><small>{shortAddress(createdMint, 7)}</small></div><button onClick={() => navigator.clipboard.writeText(createdMint)}><Copy size={15} /></button><a href={`${EXPLORER}/token/${createdMint}`} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a></div>}
                <div className="panel preview-card">
                  <div className="preview-top"><span>LIVE PREVIEW</span><i>NEW</i></div>
                  <div className="token-preview">
                    <div className="preview-image">{imagePreview ? <img src={imagePreview} alt="" /> : <Coins size={32} />}</div>
                    <div><h3>{launch.name || "Your coin"}</h3><span>${launch.symbol || "TICKER"}</span></div>
                  </div>
                  <p>{launch.description || "Your story will appear here. Keep it clear, fun and memorable."}</p>
                  <div className="curve-label"><span>Bonding curve progress</span><b>0%</b></div>
                  <div className="progress"><i style={{ width: "0%" }} /></div>
                  <div className="preview-stats"><span><small>MARKET CAP</small><b>—</b></span><span><small>REPLIES</small><b>0</b></span><span><small>CREATED</small><b>now</b></span></div>
                </div>
                <div className="info-card"><Info size={18} /><div><b>How launch works</b><p>Pump creates a fixed-supply token and an automated bonding curve. The price moves as people buy and sell. When the curve completes, liquidity migrates to PumpSwap.</p></div></div>
                <div className="trust-row"><span><ShieldCheck size={15} /> official Pump SDK</span><span><LockKeyhole size={15} /> non-custodial</span></div>
              </aside>
            </section>
          </>
        )}

        {tab === "trade" && (
          <section className="trade-page">
            <div className="section-title"><span className="eyebrow"><ArrowDownUp size={14} /> bonding curve desk</span><h1>Trade any active<br /><em>Pump coin.</em></h1><p>Paste a mint address. Quotes come from live on-chain reserves and settle through Pump's buy_v2 and sell_v2 instructions.</p></div>
            <div className="trade-grid">
              <div className="panel trade-card">
                <div className="panel-head"><div><span>02</span><h2>Trade coin</h2></div><span className="secure"><i className="live-dot" /> live mainnet</span></div>
                <div className="form-content">
                  <label><span>Token mint address</span><div className="search-input"><input value={mintInput} onChange={(e) => setMintInput(e.target.value)} placeholder="Paste Solana mint address" /><button type="button" onClick={loadCoin} disabled={busy === "load"}>{busy === "load" ? <LoaderCircle className="spin" size={18} /> : <Search size={18} />}</button></div></label>
                  {curve ? (
                    <>
                      <div className="coin-loaded">
                        <div className="coin-orb"><Coins size={22} /></div>
                        <div><b>{shortAddress(mintInput, 7)}</b><a href={`${EXPLORER}/token/${mintInput}`} target="_blank" rel="noreferrer">view on Solscan <ExternalLink size={11} /></a></div>
                        <span className={curve.bondingCurve.complete ? "graduated" : "active-curve"}>{curve.bondingCurve.complete ? "graduated" : "curve active"}</span>
                      </div>
                      <div className="curve-panel"><div className="curve-label"><span>Bonding curve</span><b>{progress.toFixed(1)}%</b></div><div className="progress"><i style={{ width: `${progress}%` }} /></div><small>{fromBaseUnits(curve.bondingCurve.realTokenReserves, 6, 0)} tokens remain on curve</small></div>
                      <div className="side-toggle"><button type="button" className={side === "buy" ? "active" : ""} onClick={() => { setSide("buy"); setTradeAmount(""); setQuote(null); }}>Buy</button><button type="button" className={side === "sell" ? "active" : ""} onClick={() => { setSide("sell"); setTradeAmount(""); setQuote(null); }}>Sell</button></div>
                      <form onSubmit={executeTrade}>
                        <label><span>{side === "buy" ? "You pay" : "You sell"}</span><div className="amount-input"><input inputMode="decimal" value={tradeAmount} onChange={(e) => { setTradeAmount(e.target.value); calculateQuote(e.target.value, side); }} placeholder="0.00" /><b>{side === "buy" ? "SOL" : "TOKEN"}</b></div></label>
                        {side === "sell" && <button className="max-button" type="button" onClick={() => { const max = fromBaseUnits(curve.balance, 6, 6).replace(/,/g, ""); setTradeAmount(max); calculateQuote(max, "sell"); }}>Balance: {fromBaseUnits(curve.balance, 6, 2)} · MAX</button>}
                        <div className="quote-row"><span>Estimated received</span><b>{quote ? fromBaseUnits(quote, side === "buy" ? 6 : 9, 6) : "—"} {side === "buy" ? "tokens" : "SOL"}</b></div>
                        <label className="slippage"><span>Slippage tolerance</span><div><input inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)} /><b>%</b></div></label>
                        <button className="primary" disabled={busy === "trade" || !quote || curve.bondingCurve.complete}>{busy === "trade" ? <><LoaderCircle className="spin" size={18} /> Confirming…</> : <>{side === "buy" ? "Buy on bonding curve" : "Sell on bonding curve"} <ChevronRight size={18} /></>}</button>
                      </form>
                    </>
                  ) : <div className="empty-state"><Search size={25} /><b>Load a Pump coin to start</b><span>The mint is verified directly against Solana.</span></div>}
                </div>
              </div>
              <div className="trade-aside">
                <div className="info-card"><ShieldCheck size={18} /><div><b>Verify every transaction</b><p>Your wallet shows the final transaction before signing. Check the mint and amount carefully—Solana transactions cannot be reversed.</p></div></div>
                <div className="mini-features"><span><b>buy_v2</b><small>Unified Pump trade route</small></span><span><b>sell_v2</b><small>On-chain slippage floor</small></span><span><b>Token-2022</b><small>New Pump mint standard</small></span></div>
              </div>
            </div>
          </section>
        )}

        {tab === "learn" && (
          <section className="learn-page">
            <div className="section-title"><span className="eyebrow"><Info size={14} /> before you launch</span><h1>Simple mechanics.<br /><em>Real consequences.</em></h1><p>CurveLab is an independent interface for the public Pump protocol. Understand the flow before spending SOL.</p></div>
            <div className="learn-grid">
              {[["01", "Create", "Your wallet creates a 6-decimal Token-2022 mint, metadata pointer and Pump bonding curve in one atomic transaction."], ["02", "Trade", "Each buy moves up the virtual reserve curve; each sell moves down. Protocol and creator fees are included in SDK quotes."], ["03", "Graduate", "When real token reserves reach zero, the curve completes and liquidity migrates. Curve trading then stops."], ["04", "Stay safe", "Never share seed phrases. Verify addresses in your wallet. Meme coins are volatile and can lose all value."]].map(([n, title, text]) => <article key={n}><span>{n}</span><div><h3>{title}</h3><p>{text}</p></div></article>)}
            </div>
            <div className="docs-banner"><div><b>Built from public protocol documentation</b><span>Review Pump's official accounts, instruction data and SDK before integrating.</span></div><a href="https://github.com/pump-fun/pump-public-docs" target="_blank" rel="noreferrer">Open docs <ArrowUpRight size={16} /></a></div>
          </section>
        )}
      </main>

      <footer><span>curvelab. <i>independent Pump interface</i></span><div><a href="https://github.com/pump-fun/pump-public-docs" target="_blank" rel="noreferrer">protocol docs</a><a href="https://solana.com" target="_blank" rel="noreferrer">solana</a><span>mainnet only</span></div></footer>
    </div>
  );
}
