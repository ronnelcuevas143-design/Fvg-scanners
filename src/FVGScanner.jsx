import { useState, useEffect, useCallback, useRef } from "react";

const COINS = [
  "BTC","ETH","BNB","SOL","XRP","ADA","AVAX","DOT","MATIC","LINK",
  "LTC","UNI","ATOM","FIL","APT","ARB","OP","INJ","SUI","SEI",
  "TIA","WLD","BLUR","DYDX","GMX","PEPE","WIF","BONK","JUP","PYTH"
];

const TIMEFRAMES = ["1W","1D","4H","1H","15M"];
const ENTRY_TFS = ["1H","30M","15M"];

const TF_MAP = {
  "1W": "1w","1D": "1d","4H": "4h","1H": "1h","15M": "15m","30M": "30m"
};

const BINANCE_BASE = "https://api.binance.com";

async function fetchBinancePrice(symbol) {
  const res = await fetch(
    `${BINANCE_BASE}/api/v3/ticker/price?symbol=${symbol}USDT`
  );
  if (!res.ok) throw new Error(`Price fetch failed for ${symbol}`);
  const data = await res.json();
  return parseFloat(data.price);
}

async function fetchBinanceKlines(symbol, interval, limit = 80) {
  const res = await fetch(
    `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`
  );
  if (!res.ok) throw new Error(`Klines fetch failed`);
  const raw = await res.json();
  return raw.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low:  parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));
}

function detectFVG(candles) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];
    const curr = candles[i];
    if (next.low > prev.high) {
      fvgs.push({ type: "bullish", top: next.low, bottom: prev.high,
        mid: (next.low + prev.high) / 2, index: i, time: curr.time, filled: false });
    }
    if (next.high < prev.low) {
      fvgs.push({ type: "bearish", top: prev.low, bottom: next.high,
        mid: (prev.low + next.high) / 2, index: i, time: curr.time, filled: false });
    }
  }
  return fvgs;
}

function detectEntryPattern(candles, bias) {
  const patterns = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
    const c1Bull = c1.close > c1.open;
    const c2Bull = c2.close > c2.open;
    const c3Bull = c3.close > c3.open;
    if (bias === "bullish" && !c1Bull && c2Bull && !c3Bull)
      patterns.push({ index: i, pattern: "RGR", bias: "bullish", candles: [c1, c2, c3] });
    else if (bias === "bearish" && c1Bull && !c2Bull && c3Bull)
      patterns.push({ index: i, pattern: "GRG", bias: "bearish", candles: [c1, c2, c3] });
  }
  return patterns;
}

async function scanCoin(coin) {
  let currentPrice;
  try { currentPrice = await fetchBinancePrice(coin); }
  catch { currentPrice = null; }

  const result = {
    coin, price: currentPrice, fvgsByTf: {}, touched: [],
    entryPatterns: [], overallBias: null, score: 0,
    error: currentPrice === null,
  };

  if (currentPrice === null) return result;

  let bullishCount = 0, bearishCount = 0;

  for (const tf of TIMEFRAMES) {
    try {
      const candles = await fetchBinanceKlines(coin, TF_MAP[tf], 80);
      const fvgs = detectFVG(candles);
      const recentFvgs = fvgs.slice(-5);
      const touched = recentFvgs.filter(
        (f) => currentPrice >= f.bottom * 0.999 && currentPrice <= f.top * 1.001
      );
      result.fvgsByTf[tf] = { fvgs: recentFvgs, touched };
      touched.forEach((t) => {
        result.touched.push({ tf, fvg: t });
        if (t.type === "bullish") bullishCount++; else bearishCount++;
      });
      recentFvgs.forEach((f) => {
        if (f.type === "bullish") bullishCount++; else bearishCount++;
      });
    } catch { result.fvgsByTf[tf] = { fvgs: [], touched: [] }; }
  }

  result.overallBias = bullishCount >= bearishCount ? "bullish" : "bearish";

  for (const tf of ENTRY_TFS) {
    try {
      const candles = await fetchBinanceKlines(coin, TF_MAP[tf], 50);
      const patterns = detectEntryPattern(candles, result.overallBias);
      if (patterns.length > 0)
        result.entryPatterns.push({ tf, pattern: patterns[patterns.length - 1] });
    } catch {}
  }

  result.score = result.touched.length * 20 + result.entryPatterns.length * 10 +
    (result.overallBias === "bullish" ? 5 : 0);
  return result;
}

const TIER_COLORS = {
  S: { bg: "#ff3c5f", text: "#fff", label: "S" },
  A: { bg: "#ff8c00", text: "#fff", label: "A" },
  B: { bg: "#f5c518", text: "#000", label: "B" },
  C: { bg: "#4ecdc4", text: "#000", label: "C" },
};

function getTier(score) {
  if (score >= 50) return "S";
  if (score >= 30) return "A";
  if (score >= 15) return "B";
  return "C";
}

function CandlePattern({ pattern }) {
  const isRGR = pattern === "RGR";
  const colors = isRGR ? ["#ef4444","#22c55e","#ef4444"] : ["#22c55e","#ef4444","#22c55e"];
  return (
    <div style={{ display: "flex", gap: 1, alignItems: "center" }}>
      {colors.map((c, i) => (
        <div key={i} style={{ width: 6, height: i === 1 ? 16 : 10,
          background: c, borderRadius: 1, opacity: 0.9 }} />
      ))}
    </div>
  );
} function DetailPanel({ coin: r }) {
  return (
    <div style={{ background: "#0d1117", borderTop: "1px solid #1e293b",
      padding: "16px 20px", display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
      {TIMEFRAMES.map((tf) => {
        const tfData = r.fvgsByTf[tf];
        return (
          <div key={tf} style={{ background: "#111827", borderRadius: 8, padding: 12,
            border: tfData?.touched?.length > 0 ? "1px solid #f59e0b40" : "1px solid #1e293b" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8" }}>{tf}</span>
              {tfData?.touched?.length > 0 && (
                <span style={{ fontSize: 9, color: "#f59e0b", background: "#f59e0b18",
                  padding: "2px 6px", borderRadius: 3 }}>● PRICE IN FVG</span>
              )}
            </div>
            {tfData?.fvgs?.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {tfData.fvgs.slice(-3).map((fvg, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "center", padding: "4px 6px", borderRadius: 4,
                    background: fvg.type === "bullish" ? "#22c55e08" : "#ef444408",
                    border: `1px solid ${fvg.type === "bullish" ? "#22c55e20" : "#ef444420"}` }}>
                    <span style={{ fontSize: 9, color: fvg.type === "bullish" ? "#22c55e" : "#ef4444" }}>
                      {fvg.type === "bullish" ? "▲" : "▼"} {fvg.type.toUpperCase()}
                    </span>
                    <span style={{ fontSize: 9, color: "#64748b" }}>
                      {fvg.bottom.toFixed(4)}–{fvg.top.toFixed(4)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <span style={{ fontSize: 10, color: "#374151" }}>No FVGs detected</span>
            )}
          </div>
        );
      })}
      {r.entryPatterns.length > 0 && (
        <div style={{ background: "#111827", borderRadius: 8, padding: 12,
          border: "1px solid #00d4ff20", gridColumn: "span 2" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#00d4ff", marginBottom: 8 }}>
            ENTRY PATTERNS DETECTED
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {r.entryPatterns.map((ep, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8,
                background: "#0d1117", padding: "8px 12px", borderRadius: 6,
                border: "1px solid #1e293b" }}>
                <span style={{ fontSize: 10, color: "#64748b" }}>{ep.tf}</span>
                <CandlePattern pattern={ep.pattern.pattern} />
                <span style={{ fontSize: 10, fontWeight: 700,
                  color: ep.pattern.bias === "bullish" ? "#22c55e" : "#ef4444" }}>
                  {ep.pattern.pattern} — {ep.pattern.bias.toUpperCase()} ENTRY
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function FVGScanner() {
  const [results, setResults] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [filter, setFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("score");
  const [selected, setSelected] = useState(null);
  const [lastScan, setLastScan] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [search, setSearch] = useState("");
  const [apiError, setApiError] = useState(null);
  const intervalRef = useRef(null);

  const runScan = useCallback(async () => {
    setScanning(true); setProgress(0); setApiError(null);
    const scanResults = [];
    for (let i = 0; i < COINS.length; i++) {
      try {
        const res = await scanCoin(COINS[i]);
        scanResults.push(res);
      } catch (err) {
        if (i === 0) setApiError("CORS error. Deploy to GitHub Pages for live data.");
        scanResults.push({ coin: COINS[i], price: null, fvgsByTf: {}, touched: [],
          entryPatterns: [], overallBias: "bearish", score: 0, error: true });
      }
      setProgress(Math.round(((i + 1) / COINS.length) * 100));
      await new Promise((r) => setTimeout(r, 120));
    }
    scanResults.sort((a, b) => b.score - a.score);
    setResults(scanResults); setLastScan(new Date()); setScanning(false);
  }, []);

  useEffect(() => { runScan(); }, []);
  useEffect(() => {
    if (autoRefresh) { intervalRef.current = setInterval(runScan, 120000); }
    else { clearInterval(intervalRef.current); }
    return () => clearInterval(intervalRef.current);
  }, [autoRefresh, runScan]);

  const filtered = results.filter((r) => {
    const matchBias = filter === "ALL" || r.overallBias?.toUpperCase() === filter;
    return matchBias && r.coin.toLowerCase().includes(search.toLowerCase());
  }).sort((a, b) => {
    if (sortBy === "score") return b.score - a.score;
    if (sortBy === "coin") return a.coin.localeCompare(b.coin);
    if (sortBy === "touched") return b.touched.length - a.touched.length;
    return 0;
  });

  const bullishCount = results.filter((r) => r.overallBias === "bullish").length;
  const bearishCount = results.filter((r) => r.overallBias === "bearish").length;
  const touchedCount = results.filter((r) => r.touched.length > 0).length;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0b0f", color: "#e0e0e0",
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
      <div style={{ background: "linear-gradient(135deg, #0d1117 0%, #111827 100%)",
        borderBottom: "1px solid #1e293b", padding: "20px 24px 16px",
        position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center",
          justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: 8,
              background: "linear-gradient(135deg, #00d4ff, #7b2fff)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 18, fontWeight: 900 }}>⊛</div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#fff",
                letterSpacing: "0.05em" }}>FVG SCANNER</div>
              <div style={{ fontSize: 10, color: "#4a5568", letterSpacing: "0.15em" }}>
                LIVE BINANCE DATA · MULTI-TIMEFRAME · ENTRY PATTERN DETECTION</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {lastScan && <span style={{ fontSize: 10, color: "#4a5568" }}>
              LAST: {lastScan.toLocaleTimeString()}</span>}
            <button onClick={() => setAutoRefresh(!autoRefresh)} style={{
              padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer",
              background: autoRefresh ? "#00d4ff22" : "#1e293b",
              color: autoRefresh ? "#00d4ff" : "#64748b",
              fontSize: 11, fontFamily: "inherit", letterSpacing: "0.08em" }}>
              {autoRefresh ? "⟳ AUTO ON" : "⟳ AUTO OFF"}
            </button>
            <button onClick={runScan} disabled={scanning} style={{
              padding: "6px 16px", borderRadius: 6, border: "none",
              cursor: scanning ? "not-allowed" : "pointer",
              background: scanning ? "#1e293b" : "linear-gradient(135deg, #00d4ff, #7b2fff)",
              color: scanning ? "#4a5568" : "#fff",
              fontSize: 11, fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.1em" }}>
              {scanning ? `SCANNING ${progress}%` : "▶ SCAN NOW"}
            </button>
          </div>
        </div>
        {scanning && (
          <div style={{ marginTop: 12, height: 2, background: "#1e293b", borderRadius: 2 }}>
            <div style={{ height: "100%", borderRadius: 2,
              background: "linear-gradient(90deg, #00d4ff, #7b2fff)",
              width: `${progress}%`, transition: "width 0.1s ease" }} />
          </div>
        )}
      </div>

      {apiError && (
        <div style={{ background: "#1a0a00", borderBottom: "1px solid #ff8c0044",
          padding: "10px 20px", fontSize: 11, color: "#ff8c00",
          display: "flex", alignItems: "center", gap: 8 }}>
          <span>⚠</span><span>{apiError}</span>
        </div>
      )}

      <div style={{ display: "flex", gap: 1, background: "#0d1117", borderBottom: "1px solid #1e293b" }}>
        {[
          { label: "TOTAL", value: results.length, color: "#94a3b8" },
          { label: "BULLISH", value: bullishCount, color: "#22c55e" },
          { label: "BEARISH", value: bearishCount, color: "#ef4444" },
          { label: "FVG TOUCHED", value: touchedCount, color: "#f59e0b" },
          { label: "WITH ENTRY", value: results.filter(r => r.entryPatterns.length > 0).length, color: "#00d4ff" },
        ].map((s) => (
          <div key={s.label} style={{ flex: 1, padding: "10px 16px", textAlign: "center",
            borderRight: "1px solid #1e293b" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 9, color: "#374151", letterSpacing: "0.12em" }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: "12px 16px", display: "flex", gap: 8, flexWrap: "wrap",
        background: "#0d1117", borderBottom: "1px solid #1e293b", alignItems: "center" }}>
        <input placeholder="Search coin..." value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 6,
            padding: "6px 12px", color: "#e0e0e0", fontSize: 12,
            fontFamily: "inherit", outline: "none", width: 140 }} />
        {["ALL","BULLISH","BEARISH"].map((f) => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer",
            background: filter === f ? (f==="BULLISH" ? "#22c55e22" : f==="BEARISH" ? "#ef444422" : "#00d4ff22") : "#111827",
            color: filter === f ? (f==="BULLISH" ? "#22c55e" : f==="BEARISH" ? "#ef4444" : "#00d4ff") : "#4a5568",
            fontSize: 11, fontFamily: "inherit", letterSpacing: "0.08em" }}>{f}</button>
        ))}
        <span style={{ color: "#1e293b" }}>|</span>
        <span style={{ fontSize: 10, color: "#374151" }}>SORT:</span>
        {["score","coin","touched"].map((s) => (
          <button key={s} onClick={() => setSortBy(s)} style={{
            padding: "5px 10px", borderRadius: 5, border: "none", cursor: "pointer",
            background: sortBy === s ? "#1e293b" : "transparent",
            color: sortBy === s ? "#94a3b8" : "#374151",
            fontSize: 10, fontFamily: "inherit", textTransform: "uppercase" }}>{s}</button>
        ))}
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#0d1117", borderBottom: "1px solid #1e293b" }}>
              {["#","COIN","PRICE","BIAS","TIER","FVG TOUCHED TF","ENTRY PATTERN","TIMEFRAMES","SCORE"].map((h) => (
                <th key={h} style={{ padding: "8px 12px", textAlign: "left",
                  color: "#374151", fontSize: 9, letterSpacing: "0.15em",
                  fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, idx) => {
              const tier = getTier(r.score);
              const tc = TIER_COLORS[tier];
              const isSelected = selected?.coin === r.coin;
              return (
                <>
                  <tr key={r.coin} onClick={() => setSelected(isSelected ? null : r)}
                    style={{ borderBottom: "1px solid #0d1117", cursor: "pointer",
                      background: isSelected ? "#111827" : idx % 2 === 0 ? "#0a0b0f" : "#0c0d12",
                      opacity: r.error ? 0.4 : 1 }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "#111827"; }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = idx % 2 === 0 ? "#0a0b0f" : "#0c0d12"; }}>
                    <td style={{ padding: "10px 12px", color: "#374151", fontSize: 10 }}>{idx + 1}</td>
                    <td style={{ padding: "10px 12px" }}>
                      <span style={{ fontWeight: 700, color: "#fff", fontSize: 13 }}>{r.coin}</span>
                      <span style={{ color: "#374151", fontSize: 9, marginLeft: 4 }}>/USDT</span>
                    </td>
                    <td style={{ padding: "10px 12px", color: r.error ? "#374151" : "#94a3b8" }}>
                      {r.error ? "ERR" : r.price == null ? "—" :
                        r.price < 0.0001 ? r.price.toFixed(8) :
                        r.price < 1 ? r.price.toFixed(5) : r.price.toFixed(2)}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <span style={{ padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                        background: r.overallBias === "bullish" ? "#22c55e18" : "#ef444418",
                        color: r.overallBias === "bullish" ? "#22c55e" : "#ef4444" }}>
                        {r.overallBias === "bullish" ? "▲ BULL" : "▼ BEAR"}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <span style={{ display: "inline-block", width: 24, height: 24,
                        borderRadius: 4, background: tc.bg, color: tc.text,
                        fontSize: 11, fontWeight: 900, textAlign: "center", lineHeight: "24px" }}>
                        {tc.label}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      {r.touched.length > 0 ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {r.touched.map((t, i) => (
                            <span key={i} style={{ padding: "2px 6px", borderRadius: 3,
                              fontSize: 9, fontWeight: 700,
                              background: t.fvg.type === "bullish" ? "#22c55e18" : "#ef444418",
                              color: t.fvg.type === "bullish" ? "#22c55e" : "#ef4444",
                              border: `1px solid ${t.fvg.type === "bullish" ? "#22c55e40" : "#ef444440"}` }}>
                              {t.tf} {t.fvg.type === "bullish" ? "↑" : "↓"}
                            </span>
                          ))}
                        </div>
                      ) : <span style={{ color: "#374151", fontSize: 10 }}>—</span>}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      {r.entryPatterns.length > 0 ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {r.entryPatterns.map((ep, i) => (
                            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                              <span style={{ fontSize: 9, color: "#64748b" }}>{ep.tf}</span>
                              <CandlePattern pattern={ep.pattern.pattern} />
                            </div>
                          ))}
                        </div>
                      ) : <span style={{ color: "#374151", fontSize: 10 }}>—</span>}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", gap: 3 }}>
                        {TIMEFRAMES.map((tf) => {
                          const tfData = r.fvgsByTf[tf];
                          const hasFVG = tfData?.fvgs?.length > 0;
                          const isTouched = tfData?.touched?.length > 0;
                          return (
                            <span key={tf} style={{ padding: "2px 5px", borderRadius: 3, fontSize: 8,
                              background: isTouched ? "#f59e0b22" : hasFVG ? "#00d4ff11" : "#1e293b",
                              color: isTouched ? "#f59e0b" : hasFVG ? "#00d4ff55" : "#374151",
                              border: isTouched ? "1px solid #f59e0b40" : "1px solid transparent" }}>
                              {tf}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ height: 4, width: 60, background: "#1e293b", borderRadius: 2 }}>
                          <div style={{ height: "100%", borderRadius: 2,
                            width: `${Math.min(100, r.score)}%`,
                            background: `linear-gradient(90deg, ${r.overallBias === "bullish" ? "#22c55e" : "#ef4444"}, ${r.overallBias === "bullish" ? "#00d4ff" : "#ff3c5f"})` }} />
                        </div>
                        <span style={{ color: "#94a3b8", fontSize: 11, fontWeight: 600 }}>{r.score}</span>
                      </div>
                    </td>
                  </tr>
                  {isSelected && (
                    <tr key={`${r.coin}-detail`}>
                      <td colSpan={9} style={{ padding: 0 }}>
                        <DetailPanel coin={r} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ padding: "16px 20px", borderTop: "1px solid #1e293b",
        display: "flex", gap: 24, flexWrap: "wrap", background: "#0a0b0f" }}>
        <div style={{ fontSize: 10, color: "#374151" }}>
          <span style={{ color: "#f59e0b" }}>■</span> FVG TOUCHED &nbsp;
          <span style={{ color: "#00d4ff55" }}>■</span> FVG DETECTED &nbsp;
          <span style={{ color: "#374151" }}>■</span> NO FVG
        </div>
        <div style={{ fontSize: 10, color: "#374151" }}>
          TIERS: <span style={{ color: "#ff3c5f" }}>S</span>=50+ &nbsp;
          <span style={{ color: "#ff8c00" }}>A</span>=30+ &nbsp;
          <span style={{ color: "#f5c518" }}>B</span>=15+ &nbsp;
          <span style={{ color: "#4ecdc4" }}>C</span>=0+
        </div>
        <div style={{ fontSize: 10, color: "#2d3748" }}>
          ⚡ Live data via Binance Public API · Auto-refresh every 2 min
        </div>
      </div>
    </div>
  );
}
