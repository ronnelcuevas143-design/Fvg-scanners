import { useState, useEffect, useCallback, useRef } from "react";

const TELEGRAM_TOKEN = "8755442528:AAGgdF7mjlPGYQir_3LILYoUePMzJ-WeXrc";
const CHAT_ID = "8797963344";

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

const TIER_COLOR = { S:"#f0c040", A:"#4af090", B:"#40aaff", C:"#aaaaaa" };
const TIER_BG    = { S:"rgba(240,192,64,0.13)", A:"rgba(74,240,144,0.10)", B:"rgba(64,170,255,0.10)", C:"rgba(170,170,170,0.07)" };

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendTelegram(msg) {
  const proxies = [
    // Proxy 1: corsproxy.io
    async () => {
      const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
      const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(tgUrl)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      return res.json();
    },
    // Proxy 2: allorigins GET
    async () => {
      const params = new URLSearchParams({ chat_id: CHAT_ID, text: msg, parse_mode: "HTML", disable_web_page_preview: "true" });
      const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?${params.toString()}`;
      const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(tgUrl)}`);
      return res.json();
    },
  ];
  for (const tryProxy of proxies) {
    try {
      const data = await tryProxy();
      console.log("TG result:", JSON.stringify(data));
      if (data?.ok) return;
    } catch (e) {
      console.log("Proxy failed, trying next...", e.message);
    }
  }
  console.log("All proxies failed.");
}

// ─── BINANCE FETCH ────────────────────────────────────────────────────────────
async function fetchKlines(symbol, interval, limit = 20) {
  const binanceUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const url = `https://api.allorigins.win/raw?url=${encodeURIComponent(binanceUrl)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch error ${res.status}`);
  return (await res.json()).map(k => ({
    t:k[0], o:parseFloat(k[1]), h:parseFloat(k[2]),
    l:parseFloat(k[3]), c:parseFloat(k[4]), v:parseFloat(k[5]),
  }));
}

// ─── FVG ─────────────────────────────────────────────────────────────────────
function detectFVGs(candles) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const prev=candles[i-2], mid=candles[i-1], curr=candles[i];
    if (prev.h < curr.l) fvgs.push({type:"bullish",top:curr.l,bottom:prev.h,midTime:mid.t,size:curr.l-prev.h});
    else if (prev.l > curr.h) fvgs.push({type:"bearish",top:prev.l,bottom:curr.h,midTime:mid.t,size:prev.l-curr.h});
  }
  return fvgs;
}

function detectEntryPattern(candles) {
  if (candles.length < 3) return null;
  const [a,b,c] = candles.slice(-3);
  const isRed   = k => k.c < k.o;
  const isGreen = k => k.c > k.o;
  if (isRed(a)&&isGreen(b)&&isRed(c))   return "RGR";
  if (isGreen(a)&&isRed(b)&&isGreen(c)) return "GRG";
  return null;
}

function scoreTier(fvgCount, entryPattern, htfFvgCount) {
  let score = Math.min(fvgCount,5)*10 + Math.min(htfFvgCount,3)*15;
  if (entryPattern) score += 20;
  if (score >= 75) return "S";
  if (score >= 55) return "A";
  if (score >= 35) return "B";
  return "C";
}

async function scanCoin(symbol) {
  const result = {symbol,timeframes:{},entryPattern:null,tier:"C",lastPrice:0,totalFvgs:0};
  let totalFvgs=0, htfFvgs=0;
  for (const tf of TIMEFRAMES) {
    try {
      const candles = await fetchKlines(symbol, tf.interval, tf.limit);
      if (!candles.length) continue;
      result.lastPrice = candles[candles.length-1].c;
      const fvgs = detectFVGs(candles);
      result.timeframes[tf.label] = fvgs;
      totalFvgs += fvgs.length;
      if (["1W","1D","4H"].includes(tf.label)) htfFvgs += fvgs.length;
      if (["1H","15M"].includes(tf.label) && !result.entryPattern)
        result.entryPattern = detectEntryPattern(candles);
    } catch { result.timeframes[tf.label]=[]; }
    await new Promise(r => setTimeout(r,120));
  }
  result.tier = scoreTier(totalFvgs, result.entryPattern, htfFvgs);
  result.totalFvgs = totalFvgs;
  return result;
}

function fmt(n) {
  if (!n||n===0) return "0.00";
  if (n>=1000) return n.toLocaleString("en-US",{maximumFractionDigits:2});
  if (n>=1)    return n.toFixed(4);
  return n.toFixed(6);
}
function timeAgo(ms) {
  if (!ms) return "—";
  const s=Math.floor((Date.now()-ms)/1000);
  if (s<60)   return `${s}s ago`;
  if (s<3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}
function getPHT() {
  return new Date().toLocaleString("en-PH",{timeZone:"Asia/Manila",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:true});
}

export default function RenderScanner() {
  const [results,setResults]       = useState([]);
  const [scanning,setScanning]     = useState(false);
  const [progress,setProgress]     = useState(0);
  const [lastScan,setLastScan]     = useState(null);
  const [filter,setFilter]         = useState("ALL");
  const [sortBy,setSortBy]         = useState("tier");
  const [selected,setSelected]     = useState(null);
  const [countdown,setCountdown]   = useState(900);
  const [sentKeys,setSentKeys]     = useState(new Set());
  const timerRef=useRef(null), cdRef=useRef(null);

  const runScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setProgress(0);
    const out=[];
    for (let i=0;i<COINS.length;i++) {
      try { out.push(await scanCoin(COINS[i])); }
      catch { out.push({symbol:COINS[i],timeframes:{},tier:"C",totalFvgs:0,lastPrice:0,entryPattern:null}); }
      setProgress(Math.round(((i+1)/COINS.length)*100));
    }
    setResults(out);
    setLastScan(Date.now());
    setScanning(false);
    setCountdown(900);

    // ── TELEGRAM ALERTS ──────────────────────────────────────────────────────
    const scanTime = getPHT();
    const newSetups = out.filter(r => {
      if (!r.entryPattern) return false;
      if (r.tier !== "S" && r.tier !== "A") return false;
      const key = `${r.symbol}-${r.entryPattern}-${r.tier}`;
      return !sentKeys.has(key);
    });

    if (newSetups.length > 0) {
      await sendTelegram(`🔍 <b>FVG SCAN — ${scanTime} PHT</b>\n━━━━━━━━━━━━━━━\nFound <b>${newSetups.length}</b> new setup(s)!`);
      const newKeys = new Set(sentKeys);
      for (const r of newSetups) {
        const emoji = r.entryPattern==="RGR" ? "🟢" : "🔴";
        const bias  = r.entryPattern==="RGR" ? "BULLISH ▲" : "BEARISH ▼";
        const coin  = r.symbol.replace("USDT","");
        await sendTelegram(
`🎯 <b>VALID FVG SETUP</b>
━━━━━━━━━━━━━━━
${emoji} <b>${coin}/USDT</b> — ${bias}
💰 Price: $${fmt(r.lastPrice)}
📊 Pattern: ${r.entryPattern}
⭐ Tier: ${r.tier} | FVGs: ${r.totalFvgs}
📈 https://www.tradingview.com/chart/?symbol=BINANCE:${coin}USDT.P
🕐 ${scanTime} PHT
━━━━━━━━━━━━━━━`
        );
        newKeys.add(`${r.symbol}-${r.entryPattern}-${r.tier}`);
        await new Promise(res=>setTimeout(res,500));
      }
      setSentKeys(newKeys);
    } else {
      console.log("No new setups to send.");
    }
  }, [scanning, sentKeys]);

  useEffect(()=>{ runScan(); },[]);
  useEffect(()=>{
    if (!scanning) {
      timerRef.current=setTimeout(runScan,900_000);
      cdRef.current=setInterval(()=>setCountdown(c=>Math.max(0,c-1)),1000);
    }
    return ()=>{ clearTimeout(timerRef.current); clearInterval(cdRef.current); };
  },[scanning,runScan]);

  const tierOrder={S:0,A:1,B:2,C:3};
  const visible=results
    .filter(r=>filter==="ALL"||r.tier===filter)
    .sort((a,b)=>{
      if(sortBy==="tier")  return tierOrder[a.tier]-tierOrder[b.tier];
      if(sortBy==="fvgs")  return b.totalFvgs-a.totalFvgs;
      if(sortBy==="price") return b.lastPrice-a.lastPrice;
      return 0;
    });
  const tierCounts=results.reduce((acc,r)=>{acc[r.tier]=(acc[r.tier]||0)+1;return acc;},{});
  const mins=Math.floor(countdown/60), secs=countdown%60;

  return (
    <div style={S.root}>
      <div style={S.header}>
        <div style={S.logoRow}>
          <div style={S.logo}>
            <span style={S.logoIcon}>⬡</span>
            <span style={S.logoText}>RENDER<span style={S.logoBold}>SCANNER</span></span>
          </div>
          <div style={S.tagline}>Multi-TF FVG · Live Binance · Telegram Alerts</div>
        </div>
        <div style={S.headerRight}>
          {lastScan&&<span style={S.lastScan}>Last: {timeAgo(lastScan)}</span>}
          {!scanning&&<span style={S.cdBadge}>⟳ {mins}:{secs.toString().padStart(2,"0")}</span>}
          <button onClick={runScan} disabled={scanning} style={{...S.scanBtn,opacity:scanning?0.5:1}}>
            {scanning?`Scanning… ${progress}%`:"Scan Now"}
          </button>
        </div>
      </div>

      {scanning&&<div style={S.progressWrap}><div style={{...S.progressBar,width:`${progress}%`}}/></div>}

      <div style={S.statsRow}>
        {["S","A","B","C"].map(t=>(
          <button key={t} onClick={()=>setFilter(filter===t?"ALL":t)} style={{...S.tierBtn,borderColor:filter===t?TIER_COLOR[t]:"transparent",background:filter===t?TIER_BG[t]:"rgba(255,255,255,0.03)"}}>
            <span style={{...S.tierLabel,color:TIER_COLOR[t]}}>{t}</span>
            <span style={S.tierCount}>{tierCounts[t]||0}</span>
          </button>
        ))}
        <button onClick={()=>setFilter("ALL")} style={{...S.tierBtn,borderColor:filter==="ALL"?"#ffffff44":"transparent",background:filter==="ALL"?"rgba(255,255,255,0.06)":"rgba(255,255,255,0.03)"}}>
          <span style={{...S.tierLabel,color:"#ccc"}}>ALL</span>
          <span style={S.tierCount}>{results.length}</span>
        </button>
        <div style={S.sortRow}>
          {["tier","fvgs","price"].map(s=>(
            <button key={s} onClick={()=>setSortBy(s)} style={{...S.sortBtn,background:sortBy===s?"rgba(255,255,255,0.10)":"transparent",color:sortBy===s?"#fff":"#888"}}>
              {s.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {results.length===0&&!scanning&&<div style={S.empty}>No results yet. Click Scan Now.</div>}

      <div style={S.tableWrap}>
        {visible.map(r=>(
          <div key={r.symbol} onClick={()=>setSelected(selected?.symbol===r.symbol?null:r)}
            style={{...S.row,background:selected?.symbol===r.symbol?TIER_BG[r.tier]:"rgba(255,255,255,0.02)",borderLeft:`3px solid ${TIER_COLOR[r.tier]}`}}>
            <div style={S.rowLeft}>
              <span style={{...S.tierBadge,color:TIER_COLOR[r.tier],borderColor:TIER_COLOR[r.tier]}}>{r.tier}</span>
              <span style={S.coinName}>{r.symbol.replace("USDT","")}</span>
              {r.entryPattern&&<span style={{...S.patternBadge,background:r.entryPattern==="RGR"?"rgba(74,240,144,0.15)":"rgba(255,80,80,0.15)",color:r.entryPattern==="RGR"?"#4af090":"#ff6060"}}>{r.entryPattern}</span>}
            </div>
            <div style={S.rowMid}>
              {TIMEFRAMES.map(tf=>{
                const fvgs=r.timeframes[tf.label]||[];
                const bull=fvgs.filter(f=>f.type==="bullish").length;
                const bear=fvgs.filter(f=>f.type==="bearish").length;
                return(
                  <div key={tf.label} style={S.tfCell}>
                    <div style={S.tfLabel}>{tf.label}</div>
                    <div style={S.tfFvgs}>
                      {bull>0&&<span style={{color:"#4af090"}}>↑{bull}</span>}
                      {bear>0&&<span style={{color:"#ff6060",marginLeft:bull>0?3:0}}>↓{bear}</span>}
                      {bull===0&&bear===0&&<span style={{color:"#444"}}>—</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={S.rowRight}>
              <div style={S.price}>${fmt(r.lastPrice)}</div>
              <div style={S.fvgTotal}>{r.totalFvgs} FVGs</div>
            </div>
          </div>
        ))}
      </div>

      {selected&&(
        <div style={S.detail}>
          <div style={S.detailHeader}>
            <span style={{...S.tierBadge,color:TIER_COLOR[selected.tier],borderColor:TIER_COLOR[selected.tier],fontSize:18}}>{selected.tier}</span>
            <span style={S.detailCoin}>{selected.symbol}</span>
            <span style={S.detailPrice}>${fmt(selected.lastPrice)}</span>
            {selected.entryPattern&&<span style={{...S.patternBadge,background:selected.entryPattern==="RGR"?"rgba(74,240,144,0.15)":"rgba(255,80,80,0.15)",color:selected.entryPattern==="RGR"?"#4af090":"#ff6060",fontSize:13}}>{selected.entryPattern} pattern</span>}
            <button onClick={()=>setSelected(null)} style={S.closeBtn}>✕</button>
          </div>
          <div style={S.detailBody}>
            {TIMEFRAMES.map(tf=>{
              const fvgs=selected.timeframes[tf.label]||[];
              if(!fvgs.length) return null;
              return(
                <div key={tf.label} style={S.detailTf}>
                  <div style={S.detailTfLabel}>{tf.label}</div>
                  <div style={S.detailFvgList}>
                    {fvgs.map((f,i)=>(
                      <div key={i} style={S.fvgTag}>
                        <span style={{color:f.type==="bullish"?"#4af090":"#ff6060"}}>{f.type==="bullish"?"▲":"▼"}</span>
                        &nbsp;<span style={{color:"#ccc"}}>{fmt(f.bottom)} – {fmt(f.top)}</span>
                        <span style={{color:"#666",marginLeft:6,fontSize:11}}>Δ{fmt(f.size)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={S.footer}>⚠ For educational purposes only. Not financial advice.</div>
    </div>
  );
}

const S = {
  root:{minHeight:"100vh",background:"#0b0d11",color:"#e0e0e0",fontFamily:"'JetBrains Mono','Fira Code',monospace",padding:"0 0 40px"},
  header:{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12,padding:"18px 24px 14px",borderBottom:"1px solid #1e2230",background:"linear-gradient(90deg,#0d1018,#111520)"},
  logoRow:{display:"flex",flexDirection:"column",gap:2},
  logo:{display:"flex",alignItems:"center",gap:10},
  logoIcon:{fontSize:26,color:"#40aaff"},
  logoText:{fontSize:20,fontWeight:300,letterSpacing:4,color:"#aac8ff"},
  logoBold:{fontWeight:800,color:"#40aaff"},
  tagline:{fontSize:11,color:"#556",letterSpacing:2,marginLeft:36},
  headerRight:{display:"flex",alignItems:"center",gap:12},
  lastScan:{fontSize:11,color:"#556"},
  cdBadge:{fontSize:12,color:"#40aaff",padding:"3px 8px",border:"1px solid #1e3a5a",borderRadius:4},
  scanBtn:{background:"linear-gradient(135deg,#1a3a6a,#204090)",color:"#9ac8ff",border:"1px solid #2a5aaa",borderRadius:6,padding:"7px 18px",fontSize:13,cursor:"pointer",letterSpacing:1,fontFamily:"inherit"},
  progressWrap:{height:3,background:"#1a1d24"},
  progressBar:{height:"100%",background:"linear-gradient(90deg,#1a5aff,#40aaff)",transition:"width 0.3s"},
  statsRow:{display:"flex",alignItems:"center",gap:8,padding:"12px 24px",borderBottom:"1px solid #151820",flexWrap:"wrap"},
  tierBtn:{display:"flex",alignItems:"center",gap:6,padding:"6px 14px",borderRadius:6,border:"1px solid transparent",cursor:"pointer",transition:"all 0.2s"},
  tierLabel:{fontWeight:800,fontSize:14},
  tierCount:{fontSize:13,color:"#666",fontWeight:600},
  sortRow:{marginLeft:"auto",display:"flex",gap:4},
  sortBtn:{padding:"5px 10px",borderRadius:4,border:"none",cursor:"pointer",fontSize:11,letterSpacing:1,fontFamily:"inherit",transition:"all 0.15s"},
  tableWrap:{padding:"8px 24px",display:"flex",flexDirection:"column",gap:4},
  row:{display:"flex",alignItems:"center",gap:16,padding:"10px 16px",borderRadius:6,cursor:"pointer",transition:"background 0.15s",flexWrap:"wrap"},
  rowLeft:{display:"flex",alignItems:"center",gap:8,minWidth:130},
  tierBadge:{fontWeight:800,fontSize:14,width:26,height:26,display:"inline-flex",alignItems:"center",justifyContent:"center",border:"1.5px solid",borderRadius:4},
  coinName:{fontWeight:700,fontSize:14,letterSpacing:1,color:"#dde"},
  patternBadge:{fontSize:11,padding:"2px 7px",borderRadius:4,fontWeight:700,letterSpacing:1},
  rowMid:{display:"flex",gap:10,flex:1,flexWrap:"wrap"},
  tfCell:{display:"flex",flexDirection:"column",alignItems:"center",minWidth:36},
  tfLabel:{fontSize:10,color:"#445",letterSpacing:1,marginBottom:2},
  tfFvgs:{fontSize:12,display:"flex",gap:2},
  rowRight:{textAlign:"right",minWidth:90},
  price:{fontSize:13,color:"#aaccff",fontWeight:600},
  fvgTotal:{fontSize:11,color:"#445",marginTop:2},
  empty:{textAlign:"center",color:"#445",padding:60,fontSize:14},
  detail:{margin:"12px 24px",background:"#0e1018",border:"1px solid #1e2535",borderRadius:8,overflow:"hidden"},
  detailHeader:{display:"flex",alignItems:"center",gap:12,padding:"12px 18px",borderBottom:"1px solid #1a2030",flexWrap:"wrap"},
  detailCoin:{fontWeight:800,fontSize:18,color:"#dde",letterSpacing:2},
  detailPrice:{fontSize:16,color:"#aaccff"},
  closeBtn:{marginLeft:"auto",background:"none",border:"none",color:"#445",fontSize:16,cursor:"pointer",padding:"4px 8px"},
  detailBody:{padding:"14px 18px",display:"flex",flexDirection:"column",gap:12},
  detailTf:{display:"flex",gap:12,alignItems:"flex-start",flexWrap:"wrap"},
  detailTfLabel:{fontWeight:700,fontSize:12,color:"#40aaff",minWidth:36,paddingTop:2,letterSpacing:1},
  detailFvgList:{display:"flex",flexWrap:"wrap",gap:6},
  fvgTag:{background:"rgba(255,255,255,0.04)",border:"1px solid #1e2535",borderRadius:4,padding:"4px 10px",fontSize:12,display:"flex",alignItems:"center"},
  footer:{textAlign:"center",fontSize:11,color:"#333",padding:"16px 24px 0",letterSpacing:0.5},
};
