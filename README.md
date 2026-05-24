# ⊛ FVG Scanner

Multi-timeframe Fair Value Gap scanner with live Binance data.

## Features
- **Live Binance API** — real OHLCV data, no mock prices
- **Multi-timeframe** — scans 1W, 1D, 4H, 1H, 15M for FVG zones
- **Entry patterns** — detects RGR (bullish) and GRG (bearish) patterns on 1H/30M/15M
- **Tier ranking** — S/A/B/C scoring system
- **Auto-refresh** — every 2 minutes (respects Binance rate limits)

## Coins Scanned
BTC ETH BNB SOL XRP ADA AVAX DOT MATIC LINK LTC UNI ATOM FIL APT ARB OP INJ SUI SEI TIA WLD BLUR DYDX GMX PEPE WIF BONK JUP PYTH

## Local Development

```bash
npm install
npm run dev
```

## Deploy to GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages → Source** → set to **GitHub Actions**
3. Edit `vite.config.js` and change `base` to match your repo name:
   ```js
   base: '/YOUR-REPO-NAME/',
   ```
4. Push to `main` — GitHub Actions will auto-build and deploy

Your app will be live at: `https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/`

## Note on CORS

Binance's public API (`api.binance.com`) works fine when deployed to GitHub Pages.
If you see CORS errors locally, run with `npm run dev` — Vite's dev server handles it,
or switch to the CORS proxy version.

## Disclaimer
For educational purposes only. Not financial advice.
