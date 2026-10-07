# StonkLab

A StonkFun-style, non-custodial board for creating and trading Pump bonding-curve tokens on Solana mainnet.

## Features

- Wallet-standard Solana wallet connection
- Token-2022 coin creation through Pump `create_v2`
- Optional atomic first buy and holder-rewards mode
- Live on-chain bonding-curve state and balances
- Pump `buy_v2` / `sell_v2` trading with slippage protection
- Metadata upload through Pump's IPFS endpoint, or a custom metadata URI

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

For production, use a dedicated Solana mainnet RPC. The public endpoint is rate-limited.

```env
VITE_SOLANA_RPC_URL=https://your-mainnet-rpc.example
```

## Important

This is an independent interface. It is not the official StonkFun or Pump product. Transactions use real SOL and are irreversible. The app never requests or stores private keys; connected wallets sign transactions locally.
