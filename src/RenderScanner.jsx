import { useState, useEffect, useCallback, useRef } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const COINS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","AVAXUSDT","DOTUSDT","MATICUSDT","LINKUSDT",
  "LTCUSDT","UNIUSDT","ATOMUSDT","FILUSDT","APTUSDT",
  "ARBUSDT","OPUSDT","INJUSDT","SUIUSDT","SEIUSDT",
  "TIAUSDT","WLDUSDT","BLURUSDT","DYDXUSDT","GMXUSDT",
  "PEPEUSDT","WIFUSDT","BONKUSDT","JUPUSDT","PYTHUSDT",
];

const TIMEFRAMES = [
  { label: "1W", interval: "1w", limit: 10 },
  { label: "1D", interval: "1d", limit: 10 },
  { label: "4H", interval: "4h", limit: 20 },
  { label: "1H", interval: "1h", limit: 30 },
  { label: "15M", interval: "15m", limit: 40 },
];

const ENTRY_TFS = ["1H", "30M", "15M"];

const TIER_COLOR = {
  S: "#f0c040",
  A: "#4af090",
  B: "#40aaff",
  C: "#aaaaaa",
};

const TIER_BG = {
  S: "rgba(240,192,64,0.13)",
  A: "rgba(74,240,144,0.10)",
  B: "rgba(64,170,255,0.10)",
  C: "rgba(170,170,170,0.07)",
};

// ─── BINANCE FETCH ─────────────────────────────────────────────────────────────
async function fetchKlines(symbol, interval, limit = 20) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance error ${res.status}`);
  const raw = await res.json();
  return raw.map((k) => ({
    t: k[0],
    o: parseFloat(k[1]),
    h: parseFloat(k[2]),
    l: parseFloat(k[3]),
    c: parseFloat(k[4]),
    v: parseFloat(k[5]),
  }));
}

// ─── FVG DETECTION ─────────────────────────────────────────────────────────────
// Bullish FVG: candle[i-2].high < candle[i].low  → gap between prev high and next low
// Bearish FVG: candle[i-2].low  > candle[i].high → gap between prev low  and next high
function detectFVGs(candles) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const prev = candles[i - 2];
    const mid  = candles[i - 1];
    const curr = candles[i];

    if (prev.h < curr.l) {
      fvgs.push({
        type: "bullish",
        top: curr.l,
        bottom: prev.h,
        midTime: mid.t,
        size: curr.l - prev.h,
      });
    } else if (prev.l > curr.h) {
      fvgs.push({
        type: "bearish",
        top: prev.l,
        bottom: curr.h,
        midTime: mid.t,
        size: prev.l - curr.h,
      });
    }
  }
  return fvgs;
}

// ─── ENTRY PATTERN DETECTION (RGR / GRG) ───────────────────────────────────────
// RGR = Red-Green-Red (bullish reversal into FVG)
// GRG = Green-Red-Green (bearish reversal)
function detectEntryPattern(candles) {
  if (candles.length < 3) return null;
  const last3 = candles.slice(-3);
  const [a, b, c] = last3;
  const isRed   = (k) => k.c < k.o;
  const isGreen = (k) => k.c > k.o;

  if (isRed(a) && isGreen(b) && isRed(c))   return "RGR"; // bullish
  if (isGreen(a) && isRed(b) && isGreen(c)) return "GRG"; // bearish
  return null;
}

// ─── TIER SCORING ──────────────────────────────────────────────────────────────
function scoreTier(fvgCount, entryPattern, htfFvgCount) {
  let score = 0;
  score += Math.min(fvgCount, 5) * 10;
  score += Math.min(htfFvgCount, 3) * 15;
  if (entryPattern) score += 20;
  if (score >= 75) return "S";
  if (score >= 55) return "A";
  if (score >= 35) return "B";
  return "C";
}

// ─── SCAN ONE COIN ─────────────────────────────────────────────────────────────
async function scanCoin(symbol) {
  const result = { symbol, timeframes: {}, entryPattern: null, tier: "C", lastPrice: 0 };

  let totalFvgs = 0;
  let htfFvgs   = 0;

  for (const tf of TIMEFRAMES) {
    try {
      const candles = await fetchKlines(symbol, tf.interval, tf.limit);
      if (candles.length === 0) continue;
      result.lastPrice = candles[candles.length - 1].c;

      const fvgs = detectFVGs(candles);
      result.timeframes[tf.label] = fvgs;
      totalFvgs += fvgs.length;
      if (["1W", "1D", "4H"].includes(tf.label)) htfFvgs += fvgs.length;

      // Entry pattern on lower TFs
      if (["1H", "15M"].includes(tf.label) && !result.entryPattern) {
        result.entryPattern = detectEntryPattern(candles);
      }
    } catch {
      result.timeframes[tf.label] = [];
    }
    // small throttle to respect rate limits
    await new Promise((r) => setTimeout(r, 80));
  }

  result.tier = scoreTier(totalFvgs, result.entryPattern, htfFvgs);
  result.totalFvgs = totalFvgs;
  return result;
}

// ─── HELPERS ───────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1)    return n.toFixed(4);
  return n.toFixed(6);
}

function timeAgo(ms) {
  if (!ms) return "—";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ─── COMPONENT ─────────────────────────────────────────────────────────────────
export default function RenderScanner() {
  const [results, setResults]       = useState([]);
  const [scanning, setScanning]     = useState(false);
  const [progress, setProgress]     = useState(0);
  const [lastScan, setLastScan]     = useState(null);
  const [filter, setFilter]         = useState("ALL");
  const [sortBy, setSortBy]         = useState("tier");
  const [selected, setSelected]     = useState(null);
  const [countdown, setCountdown]   = useState(120);
  const timerRef = useRef(null);
  const cdRef    = useRef(null);

  const runScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setProgress(0);
    const out = [];
    for (let i = 0; i < COINS.length; i++) {
      try {
        const r = await scanCoin(COINS[i]);
        out.push(r);
      } catch {
        out.push({ symbol: COINS[i], timeframes: {}, tier: "C", totalFvgs: 0, lastPrice: 0, entryPattern: null });
      }
      setProgress(Math.round(((i + 1) / COINS.length) * 100));
    }
    setResults(out);
    setLastScan(Date.now());
    setScanning(false);
    setCountdown(120);
  }, [scanning]);

  // auto-refresh every 2 min
  useEffect(() => {
    runScan();
  }, []);

  useEffect(() => {
    if (!scanning) {
      timerRef.current = setTimeout(runScan, 120_000);
      cdRef.current    = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    }
    return () => {
      clearTimeout(timerRef.current);
      clearInterval(cdRef.current);
    };
  }, [scanning, runScan]);

  // sort & filter
  const tierOrder = { S: 0, A: 1, B: 2, C: 3 };
  const visible = results
    .filter((r) => filter === "ALL" || r.tier === filter)
    .sort((a, b) => {
      if (sortBy === "tier")   return tierOrder[a.tier] - tierOrder[b.tier];
      if (sortBy === "fvgs")   return b.totalFvgs - a.totalFvgs;
      if (sortBy === "price")  return b.lastPrice - a.lastPrice;
      return 0;
    });

  const tierCounts = results.reduce((acc, r) => { acc[r.tier] = (acc[r.tier] || 0) + 1; return acc; }, {});

  return (
    <div style={styles.root}>
      {/* HEADER */}
      <div style={styles.header}>
        <div style={styles.logoRow}>
          <div style={styles.logo}>
            <span style={styles.logoIcon}>⬡</span>
            <span style={styles.logoText}>RENDER<span style={styles.logoBold}>SCANNER</span></span>
          </div>
          <div style={styles.tagline}>Multi-TF FVG · Live Binance · Auto-Refresh</div>
        </div>
        <div style={styles.headerRight}>
          {lastScan && (
            <span style={styles.lastScan}>Last scan: {timeAgo(lastScan)}</span>
          )}
          {!scanning && (
            <span style={styles.cdBadge}>⟳ {countdown}s</span>
          )}
          <button
            onClick={runScan}
            disabled={scanning}
            style={{ ...styles.scanBtn, opacity: scanning ? 0.5 : 1 }}
          >
            {scanning ? `Scanning… ${progress}%` : "Scan Now"}
          </button>
        </div>
      </div>

      {/* PROGRESS BAR */}
      {scanning && (
        <div style={styles.progressWrap}>
          <div style={{ ...styles.progressBar, width: `${progress}%` }} />
        </div>
      )}

      {/* STATS ROW */}
      <div style={styles.statsRow}>
        {["S","A","B","C"].map((t) => (
          <button
            key={t}
            onClick={() => setFilter(filter === t ? "ALL" : t)}
            style={{
              ...styles.tierBtn,
              borderColor: filter === t ? TIER_COLOR[t] : "transparent",
              background: filter === t ? TIER_BG[t] : "rgba(255,255,255,0.03)",
            }}
          >
            <span style={{ ...styles.tierLabel, color: TIER_COLOR[t] }}>{t}</span>
            <span style={styles.tierCount}>{tierCounts[t] || 0}</span>
          </button>
        ))}
        <button
          onClick={() => setFilter("ALL")}
          style={{
            ...styles.tierBtn,
            borderColor: filter === "ALL" ? "#ffffff44" : "transparent",
            background: filter === "ALL" ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.03)",
          }}
        >
          <span style={{ ...styles.tierLabel, color: "#ccc" }}>ALL</span>
          <span style={styles.tierCount}>{results.length}</span>
        </button>

        <div style={styles.sortRow}>
          {["tier","fvgs","price"].map((s) => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              style={{
                ...styles.sortBtn,
                background: sortBy === s ? "rgba(255,255,255,0.10)" : "transparent",
                color: sortBy === s ? "#fff" : "#888",
              }}
            >
              {s.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* TABLE */}
      {results.length === 0 && !scanning && (
        <div style={styles.empty}>No results yet. Click Scan Now.</div>
      )}

      <div style={styles.tableWrap}>
        {visible.map((r) => (
          <div
            key={r.symbol}
            onClick={() => setSelected(selected?.symbol === r.symbol ? null : r)}
            style={{
              ...styles.row,
              background: selected?.symbol === r.symbol
                ? TIER_BG[r.tier]
                : "rgba(255,255,255,0.02)",
              borderLeft: `3px solid ${TIER_COLOR[r.tier]}`,
            }}
          >
            <div style={styles.rowLeft}>
              <span style={{ ...styles.tierBadge, color: TIER_COLOR[r.tier], borderColor: TIER_COLOR[r.tier] }}>
                {r.tier}
              </span>
              <span style={styles.coinName}>{r.symbol.replace("USDT","")}</span>
              {r.entryPattern && (
                <span style={{
                  ...styles.patternBadge,
                  background: r.entryPattern === "RGR" ? "rgba(74,240,144,0.15)" : "rgba(255,80,80,0.15)",
                  color: r.entryPattern === "RGR" ? "#4af090" : "#ff6060",
                }}>
                  {r.entryPattern}
                </span>
              )}
            </div>
            <div style={styles.rowMid}>
              {TIMEFRAMES.map((tf) => {
                const fvgs = r.timeframes[tf.label] || [];
                const bull = fvgs.filter(f => f.type === "bullish").length;
                const bear = fvgs.filter(f => f.type === "bearish").length;
                return (
                  <div key={tf.label} style={styles.tfCell}>
                    <div style={styles.tfLabel}>{tf.label}</div>
                    <div style={styles.tfFvgs}>
                      {bull > 0 && <span style={{ color: "#4af090" }}>↑{bull}</span>}
                      {bear > 0 && <span style={{ color: "#ff6060", marginLeft: bull > 0 ? 3 : 0 }}>↓{bear}</span>}
                      {bull === 0 && bear === 0 && <span style={{ color: "#444" }}>—</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={styles.rowRight}>
              <div style={styles.price}>${fmt(r.lastPrice)}</div>
              <div style={styles.fvgTotal}>{r.totalFvgs} FVGs</div>
            </div>
          </div>
        ))}
      </div>

      {/* DETAIL PANEL */}
      {selected && (
        <div style={styles.detail}>
          <div style={styles.detailHeader}>
            <span style={{ ...styles.tierBadge, color: TIER_COLOR[selected.tier], borderColor: TIER_COLOR[selected.tier], fontSize: 18 }}>
              {selected.tier}
            </span>
            <span style={styles.detailCoin}>{selected.symbol}</span>
            <span style={styles.detailPrice}>${fmt(selected.lastPrice)}</span>
            {selected.entryPattern && (
              <span style={{
                ...styles.patternBadge,
                background: selected.entryPattern === "RGR" ? "rgba(74,240,144,0.15)" : "rgba(255,80,80,0.15)",
                color: selected.entryPattern === "RGR" ? "#4af090" : "#ff6060",
                fontSize: 13,
              }}>
                {selected.entryPattern} pattern
              </span>
            )}
            <button onClick={() => setSelected(null)} style={styles.closeBtn}>✕</button>
          </div>
          <div style={styles.detailBody}>
            {TIMEFRAMES.map((tf) => {
              const fvgs = selected.timeframes[tf.label] || [];
              if (fvgs.length === 0) return null;
              return (
                <div key={tf.label} style={styles.detailTf}>
                  <div style={styles.detailTfLabel}>{tf.label}</div>
                  <div style={styles.detailFvgList}>
                    {fvgs.map((f, i) => (
                      <div key={i} style={styles.fvgTag}>
                        <span style={{ color: f.type === "bullish" ? "#4af090" : "#ff6060" }}>
                          {f.type === "bullish" ? "▲" : "▼"}
                        </span>
                        &nbsp;
                        <span style={{ color: "#ccc" }}>
                          {fmt(f.bottom)} – {fmt(f.top)}
                        </span>
                        <span style={{ color: "#666", marginLeft: 6, fontSize: 11 }}>
                          Δ{fmt(f.size)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* FOOTER */}
      <div style={styles.footer}>
        ⚠ For educational purposes only. Not financial advice. Data via Binance public API.
      </div>
    </div>
  );
}

// ─── STYLES ────────────────────────────────────────────────────────────────────
const styles = {
  root: {
    minHeight: "100vh",
    background: "#0b0d11",
    color: "#e0e0e0",
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    padding: "0 0 40px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 12,
    padding: "18px 24px 14px",
    borderBottom: "1px solid #1e2230",
    background: "linear-gradient(90deg,#0d1018,#111520)",
  },
  logoRow: { display: "flex", flexDirection: "column", gap: 2 },
  logo: { display: "flex", alignItems: "center", gap: 10 },
  logoIcon: { fontSize: 26, color: "#40aaff" },
  logoText: { fontSize: 20, fontWeight: 300, letterSpacing: 4, color: "#aac8ff" },
  logoBold: { fontWeight: 800, color: "#40aaff" },
  tagline: { fontSize: 11, color: "#556", letterSpacing: 2, marginLeft: 36 },
  headerRight: { display: "flex", alignItems: "center", gap: 12 },
  lastScan: { fontSize: 11, color: "#556" },
  cdBadge: { fontSize: 12, color: "#40aaff", padding: "3px 8px", border: "1px solid #1e3a5a", borderRadius: 4 },
  scanBtn: {
    background: "linear-gradient(135deg,#1a3a6a,#204090)",
    color: "#9ac8ff",
    border: "1px solid #2a5aaa",
    borderRadius: 6,
    padding: "7px 18px",
    fontSize: 13,
    cursor: "pointer",
    letterSpacing: 1,
    fontFamily: "inherit",
  },
  progressWrap: { height: 3, background: "#1a1d24" },
  progressBar: { height: "100%", background: "linear-gradient(90deg,#1a5aff,#40aaff)", transition: "width 0.3s" },
  statsRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 24px",
    borderBottom: "1px solid #151820",
    flexWrap: "wrap",
  },
  tierBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 14px",
    borderRadius: 6,
    border: "1px solid transparent",
    cursor: "pointer",
    transition: "all 0.2s",
  },
  tierLabel: { fontWeight: 800, fontSize: 14 },
  tierCount: { fontSize: 13, color: "#666", fontWeight: 600 },
  sortRow: { marginLeft: "auto", display: "flex", gap: 4 },
  sortBtn: {
    padding: "5px 10px",
    borderRadius: 4,
    border: "none",
    cursor: "pointer",
    fontSize: 11,
    letterSpacing: 1,
    fontFamily: "inherit",
    transition: "all 0.15s",
  },
  tableWrap: { padding: "8px 24px", display: "flex", flexDirection: "column", gap: 4 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "10px 16px",
    borderRadius: 6,
    cursor: "pointer",
    transition: "background 0.15s",
    flexWrap: "wrap",
  },
  rowLeft: { display: "flex", alignItems: "center", gap: 8, minWidth: 130 },
  tierBadge: {
    fontWeight: 800,
    fontSize: 14,
    width: 26,
    height: 26,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1.5px solid",
    borderRadius: 4,
  },
  coinName: { fontWeight: 700, fontSize: 14, letterSpacing: 1, color: "#dde" },
  patternBadge: {
    fontSize: 11,
    padding: "2px 7px",
    borderRadius: 4,
    fontWeight: 700,
    letterSpacing: 1,
  },
  rowMid: { display: "flex", gap: 10, flex: 1, flexWrap: "wrap" },
  tfCell: { display: "flex", flexDirection: "column", alignItems: "center", minWidth: 36 },
  tfLabel: { fontSize: 10, color: "#445", letterSpacing: 1, marginBottom: 2 },
  tfFvgs: { fontSize: 12, display: "flex", gap: 2 },
  rowRight: { textAlign: "right", minWidth: 90 },
  price: { fontSize: 13, color: "#aaccff", fontWeight: 600 },
  fvgTotal: { fontSize: 11, color: "#445", marginTop: 2 },
  empty: { textAlign: "center", color: "#445", padding: 60, fontSize: 14 },
  detail: {
    margin: "12px 24px",
    background: "#0e1018",
    border: "1px solid #1e2535",
    borderRadius: 8,
    overflow: "hidden",
  },
  detailHeader: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 18px",
    borderBottom: "1px solid #1a2030",
    flexWrap: "wrap",
  },
  detailCoin: { fontWeight: 800, fontSize: 18, color: "#dde", letterSpacing: 2 },
  detailPrice: { fontSize: 16, color: "#aaccff" },
  closeBtn: {
    marginLeft: "auto",
    background: "none",
    border: "none",
    color: "#445",
    fontSize: 16,
    cursor: "pointer",
    padding: "4px 8px",
  },
  detailBody: { padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12 },
  detailTf: { display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" },
  detailTfLabel: {
    fontWeight: 700,
    fontSize: 12,
    color: "#40aaff",
    minWidth: 36,
    paddingTop: 2,
    letterSpacing: 1,
  },
  detailFvgList: { display: "flex", flexWrap: "wrap", gap: 6 },
  fvgTag: {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid #1e2535",
    borderRadius: 4,
    padding: "4px 10px",
    fontSize: 12,
    display: "flex",
    alignItems: "center",
  },
  footer: {
    textAlign: "center",
    fontSize: 11,
    color: "#333",
    padding: "16px 24px 0",
    letterSpacing: 0.5,
  },
};

