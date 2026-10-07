# StonkLab

A StonkFun-style, non-custodial board for creating and trading Pump bonding-curve tokens on Solana mainnet.

## Features

- Wallet-standard Solana wallet connection
- Token-2022 coin creation through Pump `create_v2`
- Optional atomic first buy and holder-rewards mode
- Live on-chain bonding-curve state and balances
- Pump `buy_v2` / `sell_v2` trading with slippage protection
- Metadata upload through the same-origin `/api/ipfs` proxy, or a custom metadata URI

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

The app reads mainnet through `https://solana-rpc.publicnode.com`. Solana's own `api.mainnet-beta.solana.com` returns `403 Access forbidden` to browser apps, which blocks token creation. Set a private mainnet RPC for production if you have one.

```env
VITE_SOLANA_RPC_URL=https://your-mainnet-rpc.example
```

## Important

This is an independent interface. It is not the official StonkFun or Pump product. Transactions use real SOL and are irreversible. The app never requests or stores private keys; connected wallets sign transactions locally.
