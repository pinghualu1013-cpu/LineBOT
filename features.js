// features.js — 進階功能模組
// 機會掃描 / 日週線技術分析 / 消息影響 / 策略回測 / 投資組合分析
// 由 server.js 以 require('./features')(deps) 載入，指令入口為 handle(txt, ctx)
const axios = require('axios');

module.exports = function createFeatures(deps) {
  const {
    yahooFetchWithRetry, TW_NAMES, getTwseName, getNameCache, GROQ_KEY, LINE_TOKEN,
    getTopInstitutionalStocks, getWatchlist, replyOrPush, push
  } = deps;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isNum = x => typeof x === 'number' && isFinite(x);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const avg = a => (a.length ? sum(a) / a.length : null);

  // ───────────────────────── 格式化 ─────────────────────────
  function fmt(x, d) {
    if (!isNum(x)) return '-';
    if (Math.abs(x) >= 1000) return Math.round(x).toLocaleString('en-US');
    return String(Number(x.toFixed(d === undefined ? 2 : d)));
  }
  function pct(x, d) {
    if (!isNum(x)) return '-';
    return (x >= 0 ? '+' : '') + (x * 100).toFixed(d === undefined ? 1 : d) + '%';
  }
  function tickOf(p) { if (p < 10) return 0.01; if (p < 50) return 0.05; if (p < 100) return 0.1; if (p < 500) return 0.5; if (p < 1000) return 1; return 5; }
  function roundPx(p, info) {
    if (!isNum(p)) return p;
    if (info && info.kind === 'tw') { const t = tickOf(p); return Number((Math.round(p / t) * t).toFixed(2)); }
    if (info && info.kind === 'index') return Math.round(p);
    return Number(p.toFixed(2));
  }
  const fp = (v, info) => fmt(roundPx(v, info));
  function dstr(ts) { const d = new Date((ts + 28800) * 1000); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); }
  function ymd(ts) { const d = new Date((ts + 28800) * 1000); return d.getUTCFullYear() + '/' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); }

  // ───────────────────────── 代號解析與名稱 ─────────────────────────
  const INDEX_ALIAS = {
    '加權': '^TWII', '大盤': '^TWII', '加權指數': '^TWII', 'TAIEX': '^TWII', '台股': '^TWII',
    '櫃買': '^TWOII', '那斯達克': '^IXIC', 'NASDAQ': '^IXIC', '標普': '^GSPC', 'S&P500': '^GSPC',
    '道瓊': '^DJI', '費半': '^SOX'
  };
  const localNames = {};

  function resolveSymbol(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const up = raw.toUpperCase();
    const al = INDEX_ALIAS[raw] || INDEX_ALIAS[up];
    if (al) return { kind: 'index', code: al, symbols: [al], label: raw };
    if (/^\^[A-Z0-9]+$/.test(up)) return { kind: 'index', code: up, symbols: [up], label: up };
    if (/^\d{4,6}[A-Z]{0,2}$/.test(up)) return { kind: 'tw', code: up, symbols: [up + '.TW', up + '.TWO'], label: up };
    if (/^[A-Z]{1,5}$/.test(up)) return { kind: 'us', code: up, symbols: [up], label: up };
    return null;
  }
  function findCodeByName(text) {
    const t = String(text || '').trim();
    if (t.length < 2) return null;
    const cache = getNameCache() || {};
    const all = Object.assign({}, cache, localNames, TW_NAMES);
    let best = null;
    for (const [c, n] of Object.entries(all)) {
      if (!n) continue;
      if (n === t) return c;
      if (n.length >= 2 && (n.includes(t) || t.includes(n))) { if (!best || n.length > best.len) best = { c, len: n.length }; }
    }
    return best ? best.c : null;
  }
  async function nameOf(code, series) {
    const clean = s => String(s || '').replace(/[\s　]+/g, ' ').trim();
    if (TW_NAMES[code]) return clean(TW_NAMES[code]);
    if (localNames[code]) return clean(localNames[code]);
    if (/^\d/.test(code)) { try { const n = await getTwseName(code); if (n) return clean(n); } catch (e) { /* ignore */ } }
    return clean(series && series.name);
  }
  const isETF = code => /^00/.test(code);

  // ───────────────────────── 歷史資料（含快取與限流）─────────────────────────
  // 歷史日K盤後不會變：台股盤中快取30分鐘，其餘時間快取6小時，大幅減少對外請求
  function cacheTtl() {
    const tw = new Date(Date.now() + 8 * 3600000);
    const dow = tw.getUTCDay(), hm = tw.getUTCHours() * 60 + tw.getUTCMinutes();
    const open = dow >= 1 && dow <= 5 && hm >= 540 && hm <= 835;
    return open ? 30 * 60 * 1000 : 6 * 60 * 60 * 1000;
  }
  const histCache = new Map();
  let yahooChain = Promise.resolve();
  let yahooRot = 0;
  let lastCall = 0;
  function throttled(fn) {
    const run = yahooChain.then(async () => {
      const wait = lastCall + 700 - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      return fn();
    });
    yahooChain = run.catch(() => {});
    return run;
  }
  async function fetchSeries(symbol, range) {
    const host = (yahooRot++ % 2) ? 'query2' : 'query1';
    const url = 'https://' + host + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1d&range=' + range;
    const r = await throttled(() => yahooFetchWithRetry(url, 15000));
    const res = r.data.chart.result[0];
    const q = res.indicators.quote[0];
    const ts = res.timestamp || [];
    const out = { name: res.meta.longName || res.meta.shortName || '', currency: res.meta.currency, t: [], o: [], h: [], l: [], c: [], v: [] };
    for (let i = 0; i < ts.length; i++) {
      if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) continue;
      out.t.push(ts[i]); out.o.push(q.open[i]); out.h.push(q.high[i]); out.l.push(q.low[i]); out.c.push(q.close[i]); out.v.push(q.volume[i] || 0);
    }
    if (out.c.length < 30) throw new Error('資料不足');
    return out;
  }
  const FM_TOKEN = process.env.FINMIND_TOKEN || '';
  function parseFinmind(json) {
    if (!json || json.status !== 200 || !Array.isArray(json.data)) throw new Error('FinMind ' + (json && json.msg ? json.msg : '無資料'));
    const out = { name: '', currency: 'TWD', t: [], o: [], h: [], l: [], c: [], v: [] };
    for (const r of json.data) {
      if (!r.close || !r.open || !r.max || !r.min) continue; // 停牌日(價格為0)略過
      const p = String(r.date).split('-').map(Number);
      out.t.push(Date.UTC(p[0], p[1] - 1, p[2], 1, 0, 0) / 1000); // 台北09:00，與Yahoo時間戳對齊
      out.o.push(r.open); out.h.push(r.max); out.l.push(r.min); out.c.push(r.close); out.v.push(r.Trading_Volume || 0);
    }
    if (out.c.length < 30) throw new Error('資料不足');
    return out;
  }
  async function fetchFinmind(code, range) {
    const years = range === '1y' ? 1.2 : range === '2y' ? 2.2 : 5.2;
    const start = new Date(Date.now() - years * 365 * 86400000).toISOString().slice(0, 10);
    const params = { dataset: 'TaiwanStockPrice', data_id: code, start_date: start };
    if (FM_TOKEN) params.token = FM_TOKEN;
    const r = await axios.get('https://api.finmindtrade.com/api/v4/data', { params, timeout: 20000 });
    return parseFinmind(r.data);
  }
  async function getHistory(input, range) {
    const info = resolveSymbol(input);
    if (!info) throw new Error('代號格式不正確：' + input);
    const key = info.code + '|' + range;
    const hit = histCache.get(key);
    if (hit && Date.now() - hit.at < cacheTtl()) return hit.data;
    let lastErr = null;
    if (info.kind === 'tw') { // 台股優先走 FinMind（額度高、不吃 Yahoo 限流），失敗再退回 Yahoo
      try {
        const s = await fetchFinmind(info.code, range);
        s.info = info; s.symbol = info.code; s.source = 'FinMind';
        histCache.set(key, { at: Date.now(), data: s });
        if (histCache.size > 80) histCache.delete(histCache.keys().next().value);
        return s;
      } catch (e) { console.log('FinMind 失敗 ' + info.code + '，改用 Yahoo：', e.response ? 'HTTP ' + e.response.status : e.message); }
    }
    for (const sym of info.symbols) {
      try {
        const s = await fetchSeries(sym, range);
        s.info = info; s.symbol = sym;
        histCache.set(key, { at: Date.now(), data: s });
        if (histCache.size > 80) histCache.delete(histCache.keys().next().value);
        return s;
      } catch (e) { lastErr = e; }
    }
    throw new Error('查無資料 ' + info.code + (lastErr && lastErr.response ? '（Yahoo HTTP ' + lastErr.response.status + '）' : ''));
  }
  function toWeekly(s) {
    const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
    let curKey = null;
    for (let i = 0; i < s.t.length; i++) {
      const dayNum = Math.floor((s.t[i] + 28800) / 86400);
      const key = dayNum - ((dayNum + 3) % 7); // 該週週一
      if (key !== curKey) {
        curKey = key;
        out.t.push(s.t[i]); out.o.push(s.o[i]); out.h.push(s.h[i]); out.l.push(s.l[i]); out.c.push(s.c[i]); out.v.push(s.v[i]);
      } else {
        const j = out.c.length - 1;
        out.h[j] = Math.max(out.h[j], s.h[i]); out.l[j] = Math.min(out.l[j], s.l[i]);
        out.c[j] = s.c[i]; out.v[j] += s.v[i];
      }
    }
    return out;
  }

  // ───────────────────────── 指標 ─────────────────────────
  function sma(a, n) {
    const o = new Array(a.length).fill(null); let s = 0;
    for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; }
    return o;
  }
  function ema(a, n) {
    const o = new Array(a.length).fill(null);
    if (a.length < n) return o;
    const k = 2 / (n + 1); let p = 0;
    for (let i = 0; i < n; i++) p += a[i];
    p /= n; o[n - 1] = p;
    for (let i = n; i < a.length; i++) { p = a[i] * k + p * (1 - k); o[i] = p; }
    return o;
  }
  function rsiSeries(c, n) {
    n = n || 14;
    const o = new Array(c.length).fill(null);
    if (c.length <= n) return o;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
    let ag = g / n, al = l / n;
    o[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = n + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      ag = (ag * (n - 1) + (d > 0 ? d : 0)) / n; al = (al * (n - 1) + (d < 0 ? -d : 0)) / n;
      o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return o;
  }
  function macdSeries(c) {
    const e12 = ema(c, 12), e26 = ema(c, 26);
    const macd = c.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i] - e26[i] : null);
    const first = macd.findIndex(x => x != null);
    const sig = new Array(c.length).fill(null);
    if (first >= 0) { const e = ema(macd.slice(first), 9); for (let i = 0; i < e.length; i++) sig[first + i] = e[i]; }
    const hist = macd.map((m, i) => (m != null && sig[i] != null) ? m - sig[i] : null);
    return { macd, sig, hist };
  }
  function atrSeries(h, l, c, n) {
    n = n || 14;
    const o = new Array(c.length).fill(null);
    if (c.length <= n) return o;
    const tr = c.map((_, i) => i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    let a = 0;
    for (let i = 1; i <= n; i++) a += tr[i];
    a /= n; o[n] = a;
    for (let i = n + 1; i < c.length; i++) { a = (a * (n - 1) + tr[i]) / n; o[i] = a; }
    return o;
  }
  function kdSeries(h, l, c, n) {
    n = n || 9;
    const K = new Array(c.length).fill(null), D = new Array(c.length).fill(null);
    let k = 50, d = 50;
    for (let i = n - 1; i < c.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - n + 1; j <= i; j++) { if (h[j] > hh) hh = h[j]; if (l[j] < ll) ll = l[j]; }
      const rsv = hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100;
      k = k * 2 / 3 + rsv / 3; d = d * 2 / 3 + k / 3; K[i] = k; D[i] = d;
    }
    return { K, D };
  }
  function bollSeries(c, n) {
    n = n || 20;
    const mid = sma(c, n), lo = new Array(c.length).fill(null), up = new Array(c.length).fill(null);
    for (let i = n - 1; i < c.length; i++) {
      let s = 0; for (let j = i - n + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n); lo[i] = mid[i] - 2 * sd; up[i] = mid[i] + 2 * sd;
    }
    return { mid, lo, up };
  }
  function findPivots(h, l, w) {
    const highs = [], lows = [];
    for (let i = w; i < h.length - w; i++) {
      let isH = true, isL = true;
      for (let j = i - w; j <= i + w; j++) {
        if (j === i) continue;
        if (h[j] > h[i]) isH = false;
        if (l[j] < l[i]) isL = false;
        if (!isH && !isL) break;
      }
      if (isH) highs.push({ i, p: h[i] });
      if (isL) lows.push({ i, p: l[i] });
    }
    return { highs, lows };
  }
  function stdev(a) { const m = avg(a); return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / Math.max(1, a.length - 1)); }
  function logRets(c) { const o = []; for (let i = 1; i < c.length; i++) o.push(Math.log(c[i] / c[i - 1])); return o; }

  // ───────────────────────── 支撐壓力 / 趨勢線 / 背離 ─────────────────────────
  function clusterZones(points, tol) {
    const sorted = points.slice().sort((a, b) => a.p - b.p);
    const groups = [];
    for (const pt of sorted) {
      const g = groups[groups.length - 1];
      if (g && pt.p <= g.first * (1 + tol)) g.pts.push(pt); else groups.push({ first: pt.p, pts: [pt] });
    }
    return groups.map(g => {
      const ps = g.pts.map(x => x.p);
      return { lo: Math.min(...ps), hi: Math.max(...ps), mid: avg(ps), touches: g.pts.length, lastI: Math.max(...g.pts.map(x => x.i)) };
    });
  }
  function pickZones(arr) {
    const strong = arr.filter(z => z.touches >= 2 || z.tag);
    const list = strong.slice(0, 2);
    for (const z of arr) { if (list.length >= 2) break; if (!list.includes(z)) list.push(z); }
    return list;
  }
  function buildZones(s, pv, price, cfg) {
    const start = Math.max(0, s.c.length - cfg.zoneBars);
    const pts = pv.highs.concat(pv.lows).filter(p => p.i >= start);
    const zones = clusterZones(pts, cfg.zoneTol);
    const hi = Math.max(...s.h.slice(start)), lo = Math.min(...s.l.slice(start));
    const sup = zones.filter(z => z.mid < price * 0.998);
    const res = zones.filter(z => z.mid > price * 1.002);
    if (hi > price * 1.002 && !res.some(z => z.hi >= hi * 0.995)) res.push({ lo: hi, hi, mid: hi, touches: 1, lastI: -1, tag: cfg.hiLabel });
    if (lo < price * 0.998 && !sup.some(z => z.lo <= lo * 1.005)) sup.push({ lo, hi: lo, mid: lo, touches: 1, lastI: -1, tag: cfg.loLabel });
    res.sort((a, b) => a.mid - b.mid); sup.sort((a, b) => b.mid - a.mid);
    const rs = pickZones(res).sort((a, b) => a.mid - b.mid);
    const ss = pickZones(sup).sort((a, b) => b.mid - a.mid);
    return { supports: ss, resistances: rs };
  }
  function regress(c, n) {
    n = Math.min(n, c.length);
    const y = c.slice(-n).map(Math.log);
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i]; }
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const a = (sy - b * sx) / n;
    let sse = 0, sst = 0; const my = sy / n;
    for (let i = 0; i < n; i++) { const f = a + b * i; sse += (y[i] - f) ** 2; sst += (y[i] - my) ** 2; }
    const sd = Math.sqrt(sse / n);
    const fit = a + b * (n - 1);
    const width = 4 * sd;
    return { n, slope: Math.exp(b) - 1, r2: sst ? 1 - sse / sst : 0, mid: Math.exp(fit), upper: Math.exp(fit + 2 * sd), lower: Math.exp(fit - 2 * sd), pos: width > 0 ? (y[n - 1] - (fit - 2 * sd)) / width : 0.5 };
  }
  function pivotLine(pivs, rising, last, minGap, recentBars) {
    const cand = pivs.filter(p => p.i >= last - recentBars);
    for (let k = cand.length - 1; k >= 1; k--) {
      const b = cand[k];
      for (let j = k - 1; j >= 0; j--) {
        const a = cand[j];
        if (b.i - a.i < minGap) continue;
        if (rising ? b.p > a.p : b.p < a.p) {
          const slope = (b.p - a.p) / (b.i - a.i);
          const now = b.p + slope * (last - b.i);
          if (now > 0) return { a, b, slope, now };
        }
        break;
      }
    }
    return null;
  }
  function lastCross(fast, slow, maxBack) {
    const n = fast.length;
    for (let i = n - 1; i >= Math.max(1, n - maxBack); i--) {
      if (fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null) continue;
      if (fast[i - 1] <= slow[i - 1] && fast[i] > slow[i]) return { type: '黃金交叉', bull: true, ago: n - 1 - i };
      if (fast[i - 1] >= slow[i - 1] && fast[i] < slow[i]) return { type: '死亡交叉', bull: false, ago: n - 1 - i };
    }
    return null;
  }
  function findDivergence(pv, rsi, last) {
    const rec = 25;
    const hs = pv.highs.slice(-3), ls = pv.lows.slice(-3);
    if (hs.length >= 2) {
      const b = hs[hs.length - 1], a = hs[hs.length - 2];
      if (b.i >= last - rec && b.i - a.i >= 5 && b.i - a.i <= 80 && rsi[a.i] != null && rsi[b.i] != null && b.p > a.p && rsi[b.i] < rsi[a.i] - 3 && rsi[a.i] >= 60)
        return { type: 'bear', text: '頂背離：價創高但RSI沒跟上（' + rsi[a.i].toFixed(0) + '→' + rsi[b.i].toFixed(0) + '）' };
    }
    if (ls.length >= 2) {
      const b = ls[ls.length - 1], a = ls[ls.length - 2];
      if (b.i >= last - rec && b.i - a.i >= 5 && b.i - a.i <= 80 && rsi[a.i] != null && rsi[b.i] != null && b.p < a.p && rsi[b.i] > rsi[a.i] + 3 && rsi[a.i] <= 40)
        return { type: 'bull', text: '底背離：價創低但RSI墊高（' + rsi[a.i].toFixed(0) + '→' + rsi[b.i].toFixed(0) + '）' };
    }
    return null;
  }

  // ───────────────────────── 單一週期分析 ─────────────────────────
  const DCFG = { kind: 'd', mas: [5, 10, 20, 60, 120], slopeLag: 5, pivotW: 5, zoneBars: 250, zoneTol: 0.015, regN: 60, cross: [5, 20], unit: '日', hiLabel: '年內高點', loLabel: '年內低點', lineRecent: 120, minGap: 8, maLabel: { 20: '月線', 60: '季線', 120: '半年線' } };
  const WCFG = { kind: 'w', mas: [5, 13, 26, 52], slopeLag: 3, pivotW: 3, zoneBars: 104, zoneTol: 0.03, regN: 26, cross: [13, 26], unit: '週', hiLabel: '兩年高點', loLabel: '兩年低點', lineRecent: 60, minGap: 4, maLabel: { 13: '季線', 26: '半年線', 52: '年線' } };

  // 趨勢線延伸到今日離現價太遠（>25%）就視為失真，不顯示
  function nearLine(line, price) { return line && Math.abs(line.now / price - 1) <= 0.25 ? line : null; }

  function analyzeFrame(s, cfg) {
    const c = s.c, n = c.length, last = n - 1, price = c[last];
    const mas = {}, maArr = {};
    for (const p of cfg.mas) {
      const arr = sma(c, p); maArr[p] = arr;
      const prevI = Math.max(0, last - cfg.slopeLag);
      mas[p] = { v: arr[last], prev: arr[prevI], rising: arr[last] != null && arr[prevI] != null && arr[last] > arr[prevI] };
    }
    const atr = atrSeries(s.h, s.l, c, 14)[last];
    const rsi = rsiSeries(c, 14), m = macdSeries(c), kd = kdSeries(s.h, s.l, c, 9);
    const pv = findPivots(s.h, s.l, cfg.pivotW);
    const pi = Math.max(0, last - cfg.slopeLag);
    return {
      cfg, n, price, mas, atr,
      rsi: { now: rsi[last], prev: rsi[pi] },
      hist: { now: m.hist[last], prev: m.hist[last - 1] },
      macd: m.macd[last],
      kd: { k: kd.K[last], d: kd.D[last], kp: kd.K[last - 1], dp: kd.D[last - 1] },
      zones: buildZones(s, pv, price, cfg),
      reg: regress(c, cfg.regN),
      upLine: nearLine(pivotLine(pv.lows, true, last, cfg.minGap, cfg.lineRecent), price),
      downLine: nearLine(pivotLine(pv.highs, false, last, cfg.minGap, cfg.lineRecent), price),
      div: findDivergence(pv, rsi, last),
      cross: lastCross(maArr[cfg.cross[0]], maArr[cfg.cross[1]], cfg.kind === 'd' ? 120 : 52)
    };
  }

  function zoneStr(z, info) {
    return (z.hi - z.lo) / z.mid > 0.004 ? fp(z.lo, info) + '–' + fp(z.hi, info) : fp(z.mid, info);
  }
  function zoneLine(z, info, P) {
    return zoneStr(z, info) + '（' + pct((z.mid - P) / P) + '，' + (z.tag ? z.tag : z.touches + '次觸及') + '）';
  }

  function frameText(f, title, info) {
    const P = f.price, u = f.cfg.unit, L = [];
    L.push('📊 ' + title);
    L.push('🎯 支撐／壓力');
    if (!f.zones.resistances.length) L.push('  （上方無歷史壓力，位於區間高檔）');
    const near = z => Math.abs(z.mid - P) / P <= 0.3;
    f.zones.resistances.filter(near).slice().reverse().forEach(z => L.push('  🔴 壓力 ' + zoneLine(z, info, P)));
    L.push('  ▶ 現價 ' + fp(P, info));
    f.zones.supports.filter(near).forEach(z => L.push('  🟢 支撐 ' + zoneLine(z, info, P)));
    if (!f.zones.supports.length) L.push('  （下方無歷史支撐，位於區間低檔）');

    L.push('📐 趨勢線');
    const r = f.reg;
    L.push('  近' + r.n + u + '迴歸：' + (r.slope >= 0 ? '向上' : '向下') + ' ' + pct(r.slope, 2) + '/' + u + '，R²=' + r.r2.toFixed(2) + '（' + (r.r2 >= 0.7 ? '趨勢明確' : r.r2 >= 0.4 ? '趨勢普通' : '趨勢雜亂') + '）');
    L.push('  通道 ' + fp(r.lower, info) + '～' + fp(r.upper, info) + '，現價在通道 ' + Math.round(Math.max(0, Math.min(1, r.pos)) * 100) + '% 位置');
    if (f.upLine) L.push('  上升趨勢線（連低點）今日約 ' + fp(f.upLine.now, info) + (P >= f.upLine.now ? '，在線上 ✅' : '，已跌破 ❌'));
    if (f.downLine) L.push('  下降趨勢線（連高點）今日約 ' + fp(f.downLine.now, info) + (P > f.downLine.now ? '，已突破 ✅' : '，仍在線下 ❌'));
    if (!f.upLine && !f.downLine) L.push('  近期沒有明確的連續高低點趨勢線');

    L.push('📏 關鍵均線');
    for (const p of f.cfg.mas) {
      const m = f.mas[p]; if (m.v == null) continue;
      const lab = f.cfg.maLabel[p] ? '（' + f.cfg.maLabel[p] + '）' : '';
      L.push('  MA' + p + lab + ' ' + fp(m.v, info) + '｜現價' + (P >= m.v ? '在上 ' : '在下 ') + pct((P - m.v) / m.v) + '，' + (m.rising ? '上彎' : '下彎'));
    }
    const mv = p => (f.mas[p] ? f.mas[p].v : null);
    const k = f.cfg.kind === 'd' ? [5, 10, 20, 60] : [5, 13, 26];
    const vals = k.map(mv);
    if (vals.every(v => v != null)) {
      let bull = true, bear = true;
      for (let i = 0; i < vals.length - 1; i++) { if (!(vals[i] > vals[i + 1])) bull = false; if (!(vals[i] < vals[i + 1])) bear = false; }
      L.push('  排列：' + (bull ? '多頭排列 ✅' : bear ? '空頭排列 ❌' : '糾結／轉折'));
    }
    if (f.cross) L.push('  最近交叉：MA' + f.cfg.cross[0] + '/MA' + f.cfg.cross[1] + ' ' + f.cross.type + '（' + f.cross.ago + u + '前）');

    L.push('⚡ 動能');
    if (isNum(f.rsi.now)) L.push('  RSI(14) ' + f.rsi.now.toFixed(0) + '（' + f.cfg.slopeLag + u + '前 ' + (isNum(f.rsi.prev) ? f.rsi.prev.toFixed(0) : '-') + '，' + (f.rsi.now > f.rsi.prev ? '轉強' : '轉弱') + (f.rsi.now > 70 ? '、過熱' : f.rsi.now < 30 ? '、超賣' : '') + '）');
    const h = f.hist;
    if (isNum(h.now) && isNum(h.prev)) {
      const d = h.now > 0 ? (h.now > h.prev ? '多方放大' : '多方收斂') : (h.now > h.prev ? '空方收斂（止跌中）' : '空方放大');
      L.push('  MACD柱 ' + h.now.toFixed(2) + '（前一根 ' + h.prev.toFixed(2) + '）→ ' + d + '，DIF在零軸' + (f.macd >= 0 ? '上' : '下'));
    }
    if (isNum(f.kd.k)) {
      let kt = '';
      if (isNum(f.kd.kp) && isNum(f.kd.dp)) { if (f.kd.kp <= f.kd.dp && f.kd.k > f.kd.d) kt = '，剛黃金交叉'; else if (f.kd.kp >= f.kd.dp && f.kd.k < f.kd.d) kt = '，剛死亡交叉'; }
      L.push('  KD K' + f.kd.k.toFixed(0) + '/D' + f.kd.d.toFixed(0) + (f.kd.k > 80 ? '（高檔）' : f.kd.k < 20 ? '（低檔）' : '') + kt);
    }
    if (f.div) L.push('  ' + (f.div.type === 'bull' ? '🟢 ' : '🔴 ') + f.div.text);
    return L.join('\n');
  }

  // ───────────────────────── 判斷流程 ─────────────────────────
  function stateOfWeekly(w) {
    const m26 = w.mas[26], P = w.price;
    if (!m26 || m26.v == null) return 'neutral';
    if (P > m26.v && m26.rising) return 'bull';
    if (P < m26.v && !m26.rising) return 'bear';
    return 'neutral';
  }
  function stateOfDaily(d) {
    const m20 = d.mas[20], m60 = d.mas[60], P = d.price;
    if (!m20 || m20.v == null || !m60 || m60.v == null) return 'neutral';
    if (P > m20.v && m20.v > m60.v) return 'bull';
    if (P < m20.v && m20.v < m60.v) return 'bear';
    if (P < m20.v && m20.v >= m60.v) return P >= m60.v ? 'pullback' : 'bear';
    return 'rebound';
  }
  function momentumOf(d) {
    let sc = 0, turningUp = false; const notes = [];
    const h = d.hist;
    if (isNum(h.now) && isNum(h.prev)) {
      if (h.now > 0 && h.now > h.prev) { sc += 1; turningUp = true; notes.push('MACD柱多方放大'); }
      else if (h.now > 0) { notes.push('MACD柱多方收斂'); }
      else if (h.now > h.prev) { sc += 0.5; turningUp = true; notes.push('MACD柱空方收斂'); }
      else { sc -= 1; notes.push('MACD柱空方放大'); }
    }
    const r = d.rsi.now;
    if (isNum(r)) {
      if (r > 75) { sc -= 1; notes.push('RSI ' + r.toFixed(0) + ' 過熱'); }
      else if (r >= 50) { sc += 0.5; notes.push('RSI ' + r.toFixed(0) + ' 偏強'); }
      else if (r >= 30) { sc -= 0.5; notes.push('RSI ' + r.toFixed(0) + ' 偏弱'); }
      else { sc += 0.5; notes.push('RSI ' + r.toFixed(0) + ' 超賣'); }
    }
    if (d.div) { if (d.div.type === 'bull') { sc += 1; turningUp = true; } else sc -= 1; notes.push(d.div.text); }
    const k = d.kd;
    if (isNum(k.k) && isNum(k.kp) && isNum(k.d) && isNum(k.dp)) {
      if (k.kp <= k.dp && k.k > k.d && k.k < 50) { sc += 0.5; turningUp = true; notes.push('KD低檔黃金交叉'); }
      else if (k.kp >= k.dp && k.k < k.d && k.k > 50) { sc -= 0.5; notes.push('KD高檔死亡交叉'); }
    }
    return { score: sc, notes, turningUp };
  }
  function buildPlan(d, dState, info) {
    const P = d.price, atr = d.atr || P * 0.02;
    const m20 = d.mas[20].v, m60 = d.mas[60].v;
    let entry = P, entryNote = '現價附近';
    if (dState === 'bull' && m20 && P > m20 * 1.05) { entry = m20; entryNote = '偏離月線過大，等拉回月線'; }
    const below = [];
    d.zones.supports.forEach(z => { if (z.mid < entry * 0.99) below.push(z.mid); });
    if (m20 && m20 < entry * 0.99) below.push(m20);
    if (m60 && m60 < entry * 0.99) below.push(m60);
    const sup = below.length ? Math.max(...below) : entry - 2 * atr;
    let stop = sup - 0.5 * atr;
    stop = Math.max(stop, entry - 4 * atr); stop = Math.min(stop, entry - atr);
    const ups = d.zones.resistances.filter(z => z.mid > entry * 1.01);
    let t1, t1Src;
    if (ups.length) { t1 = ups[0].mid; t1Src = ups[0].tag || '前高壓力'; } else { t1 = entry + 2.5 * atr; t1Src = 'ATR推估'; }
    const t2 = ups.length > 1 ? ups[1].mid : null;
    entry = roundPx(entry, info); stop = roundPx(stop, info); t1 = roundPx(t1, info);
    const risk = entry - stop;
    const rr = risk > 0 ? (t1 - entry) / risk : 0;
    return { entry, stop, t1, t2: t2 ? roundPx(t2, info) : null, rr, entryNote, t1Src, sup };
  }
  const W_TXT = { bull: '多頭', bear: '空頭', neutral: '盤整' };
  const D_TXT = { bull: '多頭', pullback: '回檔', rebound: '反彈', bear: '空頭', neutral: '盤整' };

  function decide(d, w, info) {
    const wS = stateOfWeekly(w), dS = stateOfDaily(d);
    const mom = momentumOf(d), plan = buildPlan(d, dS, info);
    const m26 = w.mas[26], m20 = d.mas[20], m60 = d.mas[60];
    const atr = d.atr || d.price * 0.02;
    const steps = [];
    steps.push({
      title: '① 週線大方向', ok: wS === 'bull' ? true : wS === 'bear' ? false : null,
      text: { bull: '多頭（收在26週均上方且均線上彎）', bear: '空頭（收在26週均下方且均線下彎）', neutral: '盤整／轉折（不符多頭或空頭條件）' }[wS] + (m26 && m26.v != null ? '｜26週均 ' + fp(m26.v, info) : '')
    });
    steps.push({
      title: '② 日線趨勢', ok: dS === 'bull' ? true : (dS === 'pullback' || dS === 'rebound' || dS === 'neutral') ? null : false,
      text: { bull: '多頭（價>MA20>MA60）', pullback: '多頭回檔（MA20>MA60，價在MA20下）', rebound: '築底反彈（價>MA20，但MA20仍低於MA60）', bear: '空頭（價<MA20<MA60，或跌破MA60）', neutral: '資料不足' }[dS] + (m20 && m20.v != null ? '｜MA20 ' + fp(m20.v, info) : '') + (m60 && m60.v != null ? ' / MA60 ' + fp(m60.v, info) : '')
    });
    steps.push({
      title: '③ 動能', ok: mom.score >= 1 ? true : mom.score <= -1 ? false : null,
      text: mom.notes.join('、') + '（動能分 ' + mom.score.toFixed(1) + '）'
    });
    const P = d.price;
    steps.push({
      title: '④ 位置與風報比', ok: plan.rr >= 2 ? true : plan.rr < 1.2 ? false : null,
      text: '距壓力 ' + pct((plan.t1 - P) / P) + '、距支撐 ' + pct((plan.sup - P) / P) + '｜進場 ' + fp(plan.entry, info) + '、停損 ' + fp(plan.stop, info) + '、目標 ' + fp(plan.t1, info) + ' → 風報比 ' + plan.rr.toFixed(1)
    });

    let verdict = '觀望', why = '';
    if (wS === 'bear') {
      if (dS === 'bear') { verdict = '賣出'; why = '週線、日線同步走空：持有者減碼／出場，空手不碰。'; }
      else { verdict = '觀望'; why = '週線仍是空頭，日線的反彈不追；等週線站回26週均再談。'; }
    } else if (dS === 'bear') {
      if (wS === 'neutral') { verdict = '賣出'; why = '週線無多頭支撐、日線已轉空：持有者減碼，等止跌訊號。'; }
      else { verdict = '觀望'; why = '週線仍偏多但日線跌破支撐：持有者守停損，空手等日線止穩。'; }
    } else if (dS === 'rebound' || dS === 'neutral') {
      verdict = '觀望'; why = '日線還在築底，需站穩MA60且MA20上彎才算轉強。';
    } else if (dS === 'bull') {
      const need = wS === 'bull' ? { m: 0.5, rr: 1.5 } : { m: 1, rr: 2 };
      if (mom.score >= need.m && plan.rr >= need.rr) { verdict = '買進'; why = '大小週期同向、動能支持、風報比足夠，可分批進場。'; }
      else if (mom.score <= -1.5) { verdict = '觀望'; why = '趨勢雖多但動能轉弱，持有者設好停損，空手等回檔。'; }
      else if (plan.rr < need.rr) { verdict = '觀望'; why = '離壓力太近、風報比不足，等拉回到 ' + fp(plan.entry, info) + ' 附近再看。'; }
      else { verdict = '觀望'; why = '動能還不夠強，等MACD柱放大再進。'; }
    } else { // pullback
      const nearSup = (P - plan.sup) <= 1.5 * atr;
      if (mom.turningUp && nearSup && plan.rr >= 1.5) { verdict = '買進'; why = '多頭回檔到支撐附近且動能出現轉強，可小量分批。'; }
      else { verdict = '觀望'; why = '回檔尚未止穩，等支撐處出現轉強訊號（MACD柱收斂、KD交叉）再進。'; }
    }
    const ws = wS === 'bull' ? 2 : wS === 'bear' ? -2 : 0;
    const dsc = { bull: 2, pullback: 1, rebound: 0, neutral: 0, bear: -2 }[dS];
    const score = ws + dsc + Math.max(-2, Math.min(2, mom.score)) + (plan.rr >= 2 ? 1 : plan.rr < 1 ? -1 : 0);
    return { verdict, why, steps, score, plan, wS, dS, mom };
  }

  function flowText(dec, info) {
    const L = ['🧭 判斷流程（買進／觀望／賣出）'];
    for (const st of dec.steps) L.push((st.ok === true ? '✅ ' : st.ok === false ? '❌ ' : '⚠️ ') + st.title + '：' + st.text);
    L.push('────────────');
    const icon = { '買進': '🟢', '觀望': '⚪', '賣出': '🔴' }[dec.verdict];
    L.push(icon + ' 結論：' + dec.verdict + '（綜合分 ' + dec.score.toFixed(1) + '）');
    L.push(dec.why);
    const p = dec.plan;
    if (dec.verdict !== '賣出') {
      L.push((dec.verdict === '買進' ? '📌 交易計畫：' : '📌 若之後要進場：') + '進場 ' + fp(p.entry, info) + '（' + p.entryNote + '）｜停損 ' + fp(p.stop, info) + '｜目標 ' + fp(p.t1, info) + (p.t2 ? ' → ' + fp(p.t2, info) : '') + '（' + p.t1Src + '）｜風報比 ' + p.rr.toFixed(1));
    }
    if (dec.verdict === '買進') L.push('🚫 失效：收盤跌破 ' + fp(p.stop, info) + ' 認錯；或週線轉空（跌破26週均）。');
    else if (dec.verdict === '觀望') L.push('🚫 轉買進條件：' + (dec.dS === 'bull' ? '回到進場價附近且 MACD 柱放大' : '日線重新站上 MA20 並維持 MA20>MA60') + '；跌破 ' + fp(p.stop, info) + ' 則續空手。');
    else L.push('🚫 轉強條件：收盤站回 MA20 且 MACD 柱翻正，才重新評估。');
    L.push('※ 技術面推估，不保證獲利，請自行控管風險');
    return L.join('\n');
  }

  // 盤中即時價：證交所 MIS 報價，併入「今日」那一根K（只給 技術／消息 用，掃描不加以免變慢）
  async function fetchLiveQuote(info) {
    const ex = info.kind === 'index' ? 'tse_t00.tw' : 'tse_' + info.code + '.tw|otc_' + info.code + '.tw';
    const r = await axios.get('https://mis.twse.com.tw/stock/api/getStockInfo.jsp', {
      params: { ex_ch: ex, json: 1, delay: 0, _: Date.now() }, timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.twse.com.tw/stock/index.jsp' }
    });
    const a = (r.data && r.data.msgArray) || [];
    const q = a.find(x => x && x.z && x.z !== '-' && Number(x.z) > 0);
    if (!q) return null;
    const c = Number(q.z), o = Number(q.o) || c, h = Number(q.h) || c, l = Number(q.l) || c, v = (Number(q.v) || 0) * 1000;
    const d = String(q.d || '');
    if (!/^\d{8}$/.test(d)) return null;
    return { c, o, h, l, v, date: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8), time: q.t || '' };
  }
  async function withLive(s) {
    try {
      if (s.info.kind !== 'tw' && s.info.code !== '^TWII' && s.info.label !== '加權') return s;
      const tw = new Date(Date.now() + 8 * 3600000);
      const today = tw.toISOString().slice(0, 10);
      const dow = tw.getUTCDay(), hm = tw.getUTCHours() * 60 + tw.getUTCMinutes();
      if (dow < 1 || dow > 5 || hm < 540) return s; // 週末或開盤前：沒有今日報價
      const lq = await fetchLiveQuote(s.info);
      if (!lq || lq.date !== today) return s;
      const p = lq.date.split('-').map(Number);
      const tt = Date.UTC(p[0], p[1] - 1, p[2], 1, 0, 0) / 1000;
      const n = s.c.length;
      const out = { ...s, t: s.t.slice(), o: s.o.slice(), h: s.h.slice(), l: s.l.slice(), c: s.c.slice(), v: s.v.slice() };
      const lastDay = new Date((s.t[n - 1] + 28800) * 1000).toISOString().slice(0, 10);
      if (lastDay === today) { // FinMind／Yahoo 已有今日K：以即時報價覆蓋
        out.o[n - 1] = lq.o; out.h[n - 1] = Math.max(lq.h, lq.c); out.l[n - 1] = Math.min(lq.l, lq.c); out.c[n - 1] = lq.c; if (lq.v) out.v[n - 1] = lq.v;
      } else {
        out.t.push(tt); out.o.push(lq.o); out.h.push(Math.max(lq.h, lq.c)); out.l.push(Math.min(lq.l, lq.c)); out.c.push(lq.c); out.v.push(lq.v);
      }
      out.live = lq.time || '即時';
      return out;
    } catch (e) { console.log('即時報價失敗（改用收盤資料）：', e.message); return s; }
  }

  async function techOf(input, live) {
    let s = await getHistory(input, '2y');
    if (live) s = await withLive(s);
    if (s.c.length < 130) throw new Error('歷史資料不足（需 130 根以上），新上市標的暫無法分析');
    const w = toWeekly(s);
    if (w.c.length < 30) throw new Error('週線資料不足');
    const d = analyzeFrame(s, DCFG), wf = analyzeFrame(w, WCFG);
    const info = s.info;
    return { s, w, d, wf, info, dec: decide(d, wf, info) };
  }
  function titleOf(info, name) {
    if (info.kind === 'index') return info.label + '（' + info.code + '）';
    return info.code + (name ? ' ' + name : '');
  }

  async function cmdTech(input) {
    const t = await techOf(input, true);
    const name = await nameOf(t.info.code, t.s);
    const c = t.s.c, n = c.length;
    const head = '📈 ' + titleOf(t.info, name) + (t.s.live ? '｜即時 ' : '｜收 ') + fp(t.d.price, t.info) + '（' + pct(c[n - 1] / c[n - 2] - 1, 2) + '）｜' + (t.s.live ? '報價 ' + t.s.live + '（盤中，今日K未收）' : '資料至 ' + ymd(t.s.t[n - 1]));
    return [
      head + '\n──────────────\n' + frameText(t.d, '日線（近一年）', t.info),
      frameText(t.wf, '週線（近兩年）', t.info),
      flowText(t.dec, t.info)
    ];
  }

  // ───────────────────────── 機會掃描 ─────────────────────────
  const SCAN_BASE = ['2330', '2317', '2454', '2382', '2308', '2881', '2882', '2884', '2891', '2603', '2609', '2368', '3017', '6669', '2357', '3231', '2345', '3037', '2412', '1301'];
  async function cmdScan(uid) {
    let inst = [];
    try { inst = await getTopInstitutionalStocks(6); } catch (e) { inst = []; }
    inst.forEach(x => { if (x.code && x.name) localNames[x.code] = x.name; });
    const instSet = new Set(inst.map(x => x.code));
    let wl = [];
    try { wl = await getWatchlist(uid); } catch (e) { wl = []; }
    const universe = [];
    for (const c of [].concat(wl, inst.map(x => x.code), SCAN_BASE)) { if (c && !universe.includes(c) && universe.length < 26) universe.push(c); }

    let regime = '（大盤資料取得失敗）', mkBear = false;
    try {
      const mk = await techOf('加權');
      mkBear = mk.dec.wS === 'bear' || mk.dec.dS === 'bear';
      const m60 = mk.d.mas[60].v;
      regime = '大盤 ' + fp(mk.d.price, mk.info) + '｜週線' + W_TXT[mk.dec.wS] + '、日線' + D_TXT[mk.dec.dS] + (m60 ? '｜季線 ' + fp(m60, mk.info) : '');
    } catch (e) { /* 略過 */ }

    const results = []; let fail = 0;
    for (const code of universe) {
      try { const t = await techOf(code); results.push({ code, t, name: await nameOf(code, t.s) }); }
      catch (e) { fail++; console.log('掃描略過 ' + code + ':', e.message); }
    }
    const cands = results.filter(r => r.t.dec.wS !== 'bear' && (r.t.dec.dS === 'bull' || r.t.dec.dS === 'pullback') && r.t.dec.plan.rr >= 1.5);
    cands.forEach(r => { r.rank = r.t.dec.score + (instSet.has(r.code) ? 0.5 : 0) + Math.min(r.t.dec.plan.rr, 3) * 0.2; });
    cands.sort((a, b) => b.rank - a.rank);
    const top = cands.slice(0, 5);

    const L = ['🔎 機會掃描（日線＋週線規則）', regime, '掃描 ' + results.length + ' 檔，符合條件 ' + cands.length + ' 檔' + (fail ? '（' + fail + ' 檔資料取得失敗）' : '')];
    if (mkBear) L.push('⚠️ 大盤偏弱：以下候選請降低部位、嚴守停損');
    if (fail > universe.length / 2) L.push('⚠️ Yahoo 可能限流，結果不完整，稍後再掃一次');
    L.push('──────────────');
    if (!top.length) {
      L.push('目前沒有同時滿足「週線不空、日線多頭/回檔、風報比≥1.5」的標的。');
      L.push('空手也是一種部位，等訊號再說。');
    }
    const num = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
    top.forEach((r, i) => {
      const dec = r.t.dec, p = dec.plan, info = r.t.info;
      L.push(num[i] + ' ' + r.code + (r.name ? ' ' + r.name : '') + '｜' + (dec.verdict === '買進' ? '🟢 條件成立' : '🟡 等條件'));
      L.push('   進場 ' + fp(p.entry, info) + '（' + p.entryNote + '）｜目標 ' + fp(p.t1, info) + '｜停損 ' + fp(p.stop, info) + '｜風報比 ' + p.rr.toFixed(1));
      L.push('   週線' + W_TXT[dec.wS] + '、日線' + D_TXT[dec.dS] + '；' + dec.mom.notes.slice(0, 2).join('、') + (instSet.has(r.code) ? '；法人買超榜' : ''));
    });
    L.push('──────────────');
    L.push('📌 「條件成立」可直接依計畫；「等條件」請掛單或等訊號，沒到價就不追。');
    L.push('輸入「技術 代號」看完整日/週線、「回測 代號」驗證策略。非保證獲利。');
    return [L.join('\n')];
  }

  // ───────────────────────── 消息影響 ─────────────────────────
  const INDUSTRY = {
    'PCB': ['2368', '2313', '6269'], '航運': ['2603', '2609', '2615'], '金融': ['2881', '2882', '2884', '2891'],
    '半導體': ['2330', '2454', '2303'], 'AI伺服器': ['2317', '2382', '6669'], '散熱': ['3017', '3324'],
    '塑化': ['1301', '1303', '6505'], '電信': ['2412', '3045', '4904'], '面板': ['2409', '3481'],
    '記憶體': ['2408', '2344', '8299'], '低軌衛星': ['3491', '2313', '6285'], '網通': ['2345', '3380', '2332']
  };
  function decodeXml(s) {
    return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
  }
  function parseNewsXml(xml, n) {
    const items = []; const re = /<item>([\s\S]*?)<\/item>/g; let m;
    while ((m = re.exec(xml)) && items.length < n) {
      const b = m[1];
      const title = (b.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
      const date = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
      const src = (b.match(/<(?:News:)?[Ss]ource[^>]*>([\s\S]*?)<\/(?:News:)?[Ss]ource>/) || [])[1];
      if (!title) continue;
      let t = decodeXml(title); const s2 = src ? decodeXml(src) : '';
      if (s2 && t.endsWith(' - ' + s2)) t = t.slice(0, -(s2.length + 3));
      const d = date ? new Date(date) : null;
      items.push({ title: t, source: s2, date: d && !isNaN(d) ? (d.getUTCMonth() + 1) + '/' + d.getUTCDate() : '' });
    }
    return items;
  }
  async function fetchNews(query, n) {
    const H = { 'User-Agent': 'Mozilla/5.0 (compatible; Mozilla/5.0)', 'Accept-Language': 'zh-TW,zh;q=0.9' };
    const urls = [
      'https://news.google.com/rss/search?q=' + encodeURIComponent(query + ' when:7d') + '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
      'https://www.bing.com/news/search?q=' + encodeURIComponent(query) + '&format=rss&setmkt=zh-TW&qft=interval%3d%227%22'
    ];
    for (const u of urls) {
      try {
        const r = await axios.get(u, { timeout: 12000, headers: H });
        const items = parseNewsXml(String(r.data), n || 8);
        if (items.length) return items;
      } catch (e) { console.log('fetchNews 來源失敗:', u.slice(0, 40), e.response ? e.response.status : e.message); }
    }
    return [];
  }
  let groqProblem = null;
  async function groqChat(system, user, maxTokens) {
    groqProblem = null;
    if (!GROQ_KEY) { groqProblem = 'nokey'; return null; }
    try {
      const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
        { model: 'openai/gpt-oss-120b', max_tokens: maxTokens || 2000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
        { headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' }, timeout: 45000 });
      const txt = r.data.choices[0].message.content;
      return txt && txt.trim() ? txt.trim() : null;
    } catch (e) {
      const body = e.response ? JSON.stringify(e.response.data) : e.message;
      console.log('groqChat error:', body);
      groqProblem = /expired_api_key|invalid_api_key|Invalid API Key/i.test(body) ? 'key' : 'other';
      return null;
    }
  }
  function reactionStats(s, mk) {
    const c = s.c, n = c.length;
    const ret = (arr, k) => (arr.length > k ? arr[arr.length - 1] / arr[arr.length - 1 - k] - 1 : null);
    const v = s.v; const v5 = avg(v.slice(-5)), v20 = avg(v.slice(-25, -5));
    const r = logRets(c);
    const sg = Math.sqrt(((stdev(r.slice(-20))) ** 2 + (stdev(r.slice(-60))) ** 2) / 2);
    const hi = Math.max(...c.slice(-250));
    return {
      price: c[n - 1], r1: ret(c, 1), r5: ret(c, 5), r20: ret(c, 20),
      m5: mk ? ret(mk.c, 5) : null, m20: mk ? ret(mk.c, 20) : null,
      volRatio: v20 > 0 ? v5 / v20 : null, fromHigh: c[n - 1] / hi - 1, sigma: sg
    };
  }
  function reactedText(st) {
    const L = [];
    if (isNum(st.r5) && isNum(st.m5)) {
      const rel = st.r5 - st.m5;
      L.push('近5日相對大盤 ' + pct(rel) + (Math.abs(rel) > 0.06 ? '→ 股價已大幅反應' : Math.abs(rel) > 0.03 ? '→ 部分反應' : '→ 股價反應有限，消息可能尚未完全反映'));
    }
    if (isNum(st.volRatio)) L.push('量比 ' + st.volRatio.toFixed(1) + 'x' + (st.volRatio > 1.8 ? '→ 資金已明顯進出' : st.volRatio < 0.8 ? '→ 關注度偏低' : '→ 量能正常'));
    if (isNum(st.fromHigh)) L.push('距1年高點 ' + pct(st.fromHigh) + (st.fromHigh > -0.05 ? '→ 位階高，利多易被視為已反映' : st.fromHigh < -0.25 ? '→ 位階低，利空可能已深度反映' : ''));
    return L;
  }
  function rangeText(price, sigma, info) {
    const w1 = sigma * Math.sqrt(5), m1 = sigma * Math.sqrt(21);
    return '1週（約68%）：' + fp(price * (1 - w1), info) + '～' + fp(price * (1 + w1), info) + '（±' + (w1 * 100).toFixed(1) + '%）\n' +
      '1個月（約68%）：' + fp(price * (1 - m1), info) + '～' + fp(price * (1 + m1), info) + '（±' + (m1 * 100).toFixed(1) + '%）\n' +
      '1個月（約95%）：' + fp(price * (1 - 2 * m1), info) + '～' + fp(price * (1 + 2 * m1), info);
  }
  const clean = t => String(t).replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/^\s*[-*]\s+/gm, '• ');

  async function cmdNews(query) {
    const q = query.trim();
    let target = null;
    const info0 = resolveSymbol(q);
    if (info0) target = { kind: 'single', input: q };
    else {
      const key = Object.keys(INDUSTRY).find(k => q.toLowerCase() === k.toLowerCase() || (q.length >= 2 && k.toLowerCase().includes(q.toLowerCase())));
      const code = key ? null : findCodeByName(q);
      if (key) target = { kind: 'basket', name: key, codes: INDUSTRY[key] };
      else if (code) target = { kind: 'single', input: code };
      else target = { kind: 'text' };
    }
    let mkS = null; try { mkS = await getHistory('加權', '2y'); } catch (e) { /* 略過 */ }
    let label, newsQ, facts = '', statLines = [], rangeStr = '', techLine = '', info = null, price = null, sigma = null;

    if (target.kind === 'single') {
      const t = await techOf(target.input, true);
      info = t.info; const name = await nameOf(info.code, t.s);
      label = titleOf(info, name);
      newsQ = info.kind === 'tw' ? (name || info.code) : info.kind === 'us' ? info.code + ' stock' : (info.label === '加權' || info.label === '大盤' || info.label === '台股' ? '台股 大盤' : info.label);
      const st = reactionStats(t.s, mkS);
      price = st.price; sigma = st.sigma;
      statLines = ['近1日 ' + pct(st.r1, 2) + '｜近5日 ' + pct(st.r5) + (isNum(st.m5) ? '（大盤 ' + pct(st.m5) + '）' : '') + '｜近20日 ' + pct(st.r20)].concat(reactedText(st));
      techLine = '週線' + W_TXT[t.dec.wS] + '、日線' + D_TXT[t.dec.dS] + '；技術判斷：' + t.dec.verdict;
      rangeStr = rangeText(price, sigma, info);
      facts = '標的：' + label + '；現價 ' + fp(price, info) + '；' + statLines.join('；') + '；技術：' + techLine + '；日波動約 ' + (sigma * 100).toFixed(1) + '%';
    } else if (target.kind === 'basket') {
      label = target.name + ' 族群（' + target.codes.map(c => TW_NAMES[c] || c).join('、') + '）';
      newsQ = target.name + ' 概念股';
      const rows = []; const sg = [];
      for (const c of target.codes.slice(0, 3)) {
        try { const t = await techOf(c); const st = reactionStats(t.s, mkS); sg.push(st.sigma); rows.push((TW_NAMES[c] || c) + ' 5日' + pct(st.r5) + '/20日' + pct(st.r20) + '（週' + W_TXT[t.dec.wS] + '、日' + D_TXT[t.dec.dS] + '）'); } catch (e) { /* 略過 */ }
      }
      statLines = rows;
      if (sg.length) { const s1 = avg(sg); rangeStr = '族群代表股平均日波動 ' + (s1 * 100).toFixed(1) + '%：1週約 ±' + (s1 * Math.sqrt(5) * 100).toFixed(1) + '%，1個月約 ±' + (s1 * Math.sqrt(21) * 100).toFixed(1) + '%（68%）'; }
      facts = '產業：' + target.name + '；代表股表現：' + rows.join('；');
    } else {
      label = q; newsQ = q; facts = '主題：' + q + '（無對應股價資料，僅依新聞推論）';
    }

    let news = [];
    try { news = await fetchNews(newsQ, 8); } catch (e) { console.log('fetchNews 失敗:', e.message); }
    const head = ['📰 ' + label + ' 最新消息（近7日）'];
    if (!news.length) head.push('查不到近7日新聞（Google News 無結果或暫時連不上）');
    news.slice(0, 6).forEach((n, i) => head.push((i + 1) + '. ' + (n.date ? n.date + ' ' : '') + n.title + (n.source ? '（' + n.source + '）' : '')));
    if (statLines.length) { head.push('──────────────'); head.push('📈 股價反應'); statLines.forEach(x => head.push('  ' + x)); }
    if (techLine) head.push('  ' + techLine);

    const sys = '你是嚴謹的台股/美股研究員，用繁體中文、口語簡潔。只能根據使用者提供的新聞標題與數據推論，不可編造未提供的新聞、數字或財報；不確定就明說「不確定」。不做保證獲利的表述。';
    const usr = facts + '\n\n近期新聞標題：\n' + news.map((n, i) => (i + 1) + '. [' + n.date + ' ' + n.source + '] ' + n.title).join('\n') +
      '\n\n請依序輸出，每段2-3行，總長度600字內，不要用markdown符號：\n📰 重點消息（歸納1-3個主軸）\n⏱ 短期影響（1-4週）\n🌱 長期影響（3-12個月）\n✅ 市場可能已反映的因素\n❓ 尚未反映／被忽略的風險\n🧭 部位配置方向（偏多/中性/偏空，建議比例區間與分批方式）\n🚫 判斷失效條件（具體價位或事件）';
    const ai = news.length ? await groqChat(sys, usr, 2200) : null;

    const out2 = [];
    if (ai) out2.push('🧠 影響分析（AI依上述標題與數據推論）\n' + clean(ai));
    else if (!news.length) out2.push('⚠️ 抓不到近期新聞，無法做消息面推論（不讓AI憑空猜）。\n以下僅提供量化資訊。');
    else out2.push('⚠️ AI 解讀暫時無法使用' + (groqProblem === 'key' ? '：Groq API 金鑰失效，請到 Render 更新 GROQ_API_KEY' : groqProblem === 'nokey' ? '：未設定 GROQ_API_KEY' : '，稍後再試') + '\n以下僅提供量化資訊。');
    if (rangeStr) out2.push('📐 預期波動區間（統計推估，未含消息跳空）\n' + rangeStr + (price ? '\n※ 以近期波動度推算，不是預測；重大消息可能直接跳空超出區間。' : ''));
    return [head.join('\n'), out2.join('\n──────────────\n')];
  }

  // ───────────────────────── 策略回測 ─────────────────────────
  function prepInd(s) {
    const ind = { c: s.c, o: s.o, h: s.h, l: s.l, t: s.t, cache: {} };
    ind.ma = p => ind.cache['m' + p] || (ind.cache['m' + p] = sma(s.c, p));
    ind.rsi = rsiSeries(s.c, 14); ind.macd = macdSeries(s.c); ind.atr = atrSeries(s.h, s.l, s.c, 14); ind.boll = bollSeries(s.c, 20);
    return ind;
  }
  const STRATS = {
    ma: { short: '均線', name: '均線交叉', def: { fast: 5, slow: 20 }, label: p => p.fast + '/' + p.slow, rule: p => 'MA' + p.fast + ' 上穿 MA' + p.slow + ' 買進、下穿賣出', fromNums: n => ({ fast: n[0], slow: n[1] }) },
    rsi: { short: 'RSI', name: 'RSI超賣反彈', def: { lo: 30, hi: 55 }, label: p => '<' + p.lo + '買/>' + p.hi + '賣', rule: p => 'RSI(14)<' + p.lo + ' 買進、>' + p.hi + ' 賣出（最久持有40天）', fromNums: n => ({ lo: n[0], hi: n[1] }) },
    div: { short: '背離', name: 'RSI底背離', def: {}, label: () => '', rule: () => '價創低但RSI墊高（底背離確認）買進；RSI>60、跌破低點3%或持有40天賣出', fromNums: () => ({}) },
    macd: { short: 'MACD', name: 'MACD交叉', def: {}, label: () => '', rule: () => 'MACD柱由負轉正買進、由正轉負賣出', fromNums: () => ({}) },
    boll: { short: '布林', name: '布林下軌反彈', def: {}, label: () => '', rule: () => '收盤由布林下軌下方回到軌道內買進；站上中軌賣出（最久30天）', fromNums: () => ({}) },
    brk: { short: '突破', name: '區間突破', def: { up: 20, dn: 10 }, label: p => p.up + '/' + p.dn, rule: p => '收盤突破前' + p.up + '日高點買進；跌破前' + p.dn + '日低點賣出', fromNums: n => ({ up: n[0], dn: n[1] }) }
  };
  function buildStrat(key, p, ind) {
    const { c, h, l } = ind, n = c.length;
    if (key === 'ma') {
      const f = ind.ma(p.fast), s = ind.ma(p.slow);
      const ok = i => i > 0 && f[i] != null && s[i] != null && f[i - 1] != null && s[i - 1] != null;
      return { entry: i => ok(i) && f[i - 1] <= s[i - 1] && f[i] > s[i], exit: i => ok(i) && f[i - 1] >= s[i - 1] && f[i] < s[i] };
    }
    if (key === 'rsi') { const r = ind.rsi; return { entry: i => r[i] != null && r[i] < p.lo, exit: i => r[i] != null && r[i] > p.hi, maxHold: 40 }; }
    if (key === 'div') {
      const w = 4, pv = findPivots(h, l, w), sig = new Array(n).fill(0), r = ind.rsi;
      for (let k = 1; k < pv.lows.length; k++) {
        const b = pv.lows[k], a = pv.lows[k - 1], gap = b.i - a.i;
        if (gap < 5 || gap > 60 || r[a.i] == null || r[b.i] == null) continue;
        if (b.p < a.p && r[b.i] > r[a.i] + 3 && r[a.i] < 45 && b.i + w < n) sig[b.i + w] = b.p;
      }
      return { entry: i => sig[i] || false, exit: (i, pos) => (r[i] != null && r[i] > 60) || c[i] < pos.ext * 0.97, maxHold: 40 };
    }
    if (key === 'macd') {
      const hs = ind.macd.hist, ok = i => i > 0 && hs[i] != null && hs[i - 1] != null;
      return { entry: i => ok(i) && hs[i - 1] <= 0 && hs[i] > 0, exit: i => ok(i) && hs[i - 1] >= 0 && hs[i] < 0 };
    }
    if (key === 'boll') {
      const b = ind.boll;
      return { entry: i => i > 0 && b.lo[i] != null && b.lo[i - 1] != null && c[i - 1] < b.lo[i - 1] && c[i] >= b.lo[i], exit: i => b.mid[i] != null && c[i] > b.mid[i], maxHold: 30 };
    }
    if (key === 'brk') {
      return {
        entry: i => { if (i < p.up) return false; let m = -Infinity; for (let j = i - p.up; j < i; j++) if (h[j] > m) m = h[j]; return c[i] > m; },
        exit: i => { if (i < p.dn) return false; let m = Infinity; for (let j = i - p.dn; j < i; j++) if (l[j] < m) m = l[j]; return c[i] < m; }
      };
    }
    throw new Error('未知策略');
  }
  function simulate(ind, strat, opts, from, costs) {
    const n = ind.c.length, o = ind.o, c = ind.c, l = ind.l;
    const ma60 = ind.ma(60), ma130 = ind.ma(130);
    const buy = px => px * (1 + costs.buy), sell = px => px * (1 - costs.sell);
    const trades = [], equity = new Array(n).fill(1);
    let eq = 1, pos = null, pendEntry = null, pendExit = false, inMarket = 0;
    const closePos = (i, px, why) => { const r = sell(px) / pos.px - 1; eq = pos.eq0 * (1 + r); trades.push({ i0: pos.i0, i1: i, ret: r, bars: i - pos.i0, why }); pos = null; };
    const filterOK = i => (!opts.trend60 || (ma60[i] != null && c[i] > ma60[i])) && (!opts.weekly || (ma130[i] != null && c[i] > ma130[i]));
    for (let i = from; i < n; i++) {
      if (pendExit && pos) closePos(i, o[i], '訊號出場');
      pendExit = false;
      if (pendEntry && !pos) {
        const px = o[i];
        const sigATR = ind.atr[pendEntry.sigI];
        pos = { i0: i, px: buy(px), ext: pendEntry.ext, eq0: eq, stop: (opts.atrStop && sigATR) ? px - opts.atrStop * sigATR : null };
      }
      pendEntry = null;
      if (pos && pos.stop != null && l[i] <= pos.stop) closePos(i, Math.min(o[i], pos.stop), 'ATR停損');
      if (pos) {
        if (strat.maxHold && i - pos.i0 >= strat.maxHold) pendExit = true;
        else if (strat.exit(i, pos)) pendExit = true;
      } else if (i < n - 1) {
        const ext = strat.entry(i);
        if (ext && filterOK(i)) pendEntry = { ext, sigI: i };
      }
      equity[i] = pos ? pos.eq0 * (sell(c[i]) / pos.px) : eq;
      if (pos) inMarket++;
    }
    if (pos) { closePos(n - 1, c[n - 1], '期末未平倉'); equity[n - 1] = eq; }
    return { trades, equity, inMarket };
  }
  function pfOf(trs) {
    if (!trs.length) return null;
    const gp = sum(trs.filter(t => t.ret > 0).map(t => t.ret)), gl = -sum(trs.filter(t => t.ret <= 0).map(t => t.ret));
    return gl === 0 ? (gp > 0 ? Infinity : 0) : gp / gl;
  }
  function statsOf(sim, ind, from, costs) {
    const n = ind.c.length, tr = sim.trades, rets = tr.map(t => t.ret);
    const wins = rets.filter(r => r > 0), losses = rets.filter(r => r <= 0);
    let peak = 1, mdd = 0;
    for (let i = from; i < n; i++) { const e = sim.equity[i]; if (e > peak) peak = e; const dd = e / peak - 1; if (dd < mdd) mdd = dd; }
    const o = ind.o, c = ind.c;
    const bhTotal = (c[n - 1] * (1 - costs.sell)) / (o[from] * (1 + costs.buy)) - 1;
    let bp = c[from], bmdd = 0;
    for (let i = from; i < n; i++) { if (c[i] > bp) bp = c[i]; const dd = c[i] / bp - 1; if (dd < bmdd) bmdd = dd; }
    return {
      n: tr.length, wins: wins.length, winRate: tr.length ? wins.length / tr.length : null, pf: pfOf(tr),
      avgRet: avg(rets), avgWin: avg(wins), avgLoss: avg(losses), mdd, total: sim.equity[n - 1] - 1,
      avgBars: avg(tr.map(t => t.bars)), exposure: sim.inMarket / (n - from), trades: tr, bh: { total: bhTotal, mdd: bmdd }
    };
  }
  function runBT(s, ind, key, params, opts, from) {
    const info = s.info;
    const costs = info.kind === 'tw' ? { buy: 0.001425, sell: 0.001425 + (isETF(info.code) ? 0.001 : 0.003) } : { buy: 0, sell: 0 };
    const sim = simulate(ind, buildStrat(key, params, ind), opts || {}, from, costs);
    return { st: statsOf(sim, ind, from, costs), costs };
  }
  const fPF = x => (x === null || x === undefined ? '-' : x === Infinity ? '∞' : x.toFixed(2));
  function variantsOf(key, base) {
    const v = [
      { name: '基準（原始規則）', p: base, o: {} },
      { name: '＋趨勢濾網（價>MA60才進場）', p: base, o: { trend60: true } },
      { name: '＋週線濾網（價>26週均才進場）', p: base, o: { weekly: true } },
      { name: '＋2.5×ATR停損', p: base, o: { atrStop: 2.5 } },
      { name: '＋趨勢濾網＋ATR停損', p: base, o: { trend60: true, atrStop: 2.5 } }
    ];
    const addP = (p, nm) => { if (JSON.stringify(p) !== JSON.stringify(base)) v.push({ name: '參數 ' + nm, p, o: {} }); };
    if (key === 'ma') { addP({ fast: 10, slow: 30 }, '10/30'); addP({ fast: 20, slow: 60 }, '20/60'); }
    if (key === 'rsi') { addP({ lo: 25, hi: 55 }, 'RSI<25買/>55賣'); addP({ lo: 30, hi: 65 }, 'RSI<30買/>65賣'); }
    if (key === 'brk') { addP({ up: 55, dn: 20 }, '55/20'); addP({ up: 10, dn: 5 }, '10/5'); }
    return v;
  }
  function parseBT(rest) {
    const toks = rest.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return { error: 'usage' };
    const target = toks.shift();
    let key = null, years = 3, nums = null;
    for (const t of toks) {
      const low = t.toLowerCase();
      let m;
      if ((m = t.match(/^(\d+(?:\.\d+)?)(年|y)$/i))) { years = parseFloat(m[1]); continue; }
      if ((m = t.match(/^(\d+)(個月|月|m)$/i))) { years = parseInt(m[1], 10) / 12; continue; }
      if ((m = t.match(/^(\d+)\/(\d+)$/))) { nums = [parseInt(m[1], 10), parseInt(m[2], 10)]; continue; }
      if (/背離|div/.test(low)) key = 'div';
      else if (/均線|交叉|ma/.test(low) && !/macd/.test(low)) key = 'ma';
      else if (/macd/.test(low)) key = 'macd';
      else if (/rsi|超賣/.test(low)) key = 'rsi';
      else if (/布林|boll/.test(low)) key = 'boll';
      else if (/突破|brk|breakout/.test(low)) key = 'brk';
      else if (/^(全部|所有|all)$/.test(low)) key = null;
      else return { error: '看不懂「' + t + '」' };
    }
    years = Math.max(0.5, Math.min(5, years));
    return { target, key, years, nums };
  }
  const BT_USAGE = '用法：回測 代號 [策略] [期間] [參數]\n策略：均線／RSI／背離／MACD／布林／突破（不寫＝全部比較）\n期間：1年、3年、6個月（最長5年，預設3年）\n例：\n回測 2330\n回測 2330 均線 5年\n回測 2330 均線 10/30 3年\n回測 0050 背離 3年';

  async function cmdBacktest(rest) {
    const pr = parseBT(rest);
    if (pr.error) return [(pr.error === 'usage' ? '' : '⚠️ ' + pr.error + '\n') + BT_USAGE];
    let input = pr.target;
    if (!resolveSymbol(input)) { const c = findCodeByName(input); if (c) input = c; }
    const s = await getHistory(input, '5y');
    const n = s.c.length;
    if (n < 260) throw new Error('歷史資料不足（至少需約1年）');
    const ind = prepInd(s);
    const from = Math.max(130, n - Math.round(pr.years * 245));
    if (n - from < 100) throw new Error('可回測期間太短');
    const name = await nameOf(s.info.code, s);
    const span = ymd(s.t[from]) + '–' + ymd(s.t[n - 1]);
    const yrs = ((n - from) / 245).toFixed(1);
    const head = '📊 回測｜' + titleOf(s.info, name) + '｜近' + yrs + '年（' + span + '）';
    const costTxt = s.info.kind === 'tw' ? '含手續費0.1425%×2＋證交稅' + (isETF(s.info.code) ? '0.1%' : '0.3%') + '（未計折讓）' : '未計交易成本';

    if (!pr.key) {
      const rows = []; let bh = null;
      for (const k of Object.keys(STRATS)) {
        const r = runBT(s, ind, k, STRATS[k].def, {}, from); bh = r.st.bh;
        rows.push({ k, st: r.st });
      }
      const L = [head, '規則：訊號收盤確認、隔日開盤成交，一次一檔全進出；' + costTxt, '買進持有：' + pct(bh.total) + '（最大回撤 ' + pct(bh.mdd) + '）', '──────────────'];
      for (const r of rows) {
        const st = r.st, lab = STRATS[r.k].label(STRATS[r.k].def);
        L.push('▪ ' + STRATS[r.k].name + (lab ? '（' + lab + '）' : ''));
        L.push(st.n ? '  ' + st.n + '筆｜勝率 ' + (st.winRate * 100).toFixed(0) + '%｜PF ' + fPF(st.pf) + '｜平均 ' + pct(st.avgRet, 1) + '/筆｜MDD ' + pct(st.mdd, 0) + '｜總報酬 ' + pct(st.total, 0) : '  期間內沒有交易訊號');
      }
      const elig = rows.filter(r => r.st.n >= 5 && r.st.pf !== null);
      elig.sort((a, b) => (b.st.total / Math.max(0.05, -b.st.mdd)) - (a.st.total / Math.max(0.05, -a.st.mdd)));
      L.push('──────────────');
      if (elig.length) L.push('🏆 報酬/回撤比最佳：' + STRATS[elig[0].k].name + '。輸入「回測 ' + s.info.code + ' ' + STRATS[elig[0].k].short + '」看詳細績效與改進實驗。');
      else L.push('各策略交易次數都偏少（<5筆），結果不具統計意義，建議拉長期間或換標的。');
      L.push('※ 歷史績效不代表未來；單一標的回測容易過度配適。');
      return [L.join('\n')];
    }

    const key = pr.key, S = STRATS[key];
    let base = S.def;
    if (pr.nums && pr.nums.length >= 2) base = S.fromNums(pr.nums);
    if (key === 'ma' && base.fast >= base.slow) return ['⚠️ 均線參數需「短/長」，例如 10/30'];
    const r0 = runBT(s, ind, key, base, {}, from), st = r0.st;
    const L = [head, '策略：' + S.name + (S.label(base) ? '（' + S.label(base) + '）' : ''), '規則：' + S.rule(base), '成交：訊號收盤確認、隔日開盤；' + costTxt, '──────────────'];
    if (!st.n) { L.push('期間內沒有出現交易訊號，換個期間或策略試試。'); return [L.join('\n')]; }
    L.push('交易次數 ' + st.n + '｜勝率 ' + (st.winRate * 100).toFixed(1) + '%（' + st.wins + '/' + st.n + '）');
    L.push('獲利因子 PF ' + fPF(st.pf) + '｜平均報酬 ' + pct(st.avgRet, 2) + '/筆（均賺 ' + pct(st.avgWin, 1) + '／均賠 ' + pct(st.avgLoss, 1) + '）');
    L.push('最大回撤 ' + pct(st.mdd, 1) + '｜策略總報酬 ' + pct(st.total, 1) + '（買進持有 ' + pct(st.bh.total, 1) + '，回撤 ' + pct(st.bh.mdd, 1) + '）');
    L.push('平均持有 ' + (st.avgBars ? st.avgBars.toFixed(0) : '-') + ' 天｜在場時間 ' + (st.exposure * 100).toFixed(0) + '%');
    const split = from + 0.7 * (n - from);
    const ins = st.trades.filter(t => t.i0 < split), oos = st.trades.filter(t => t.i0 >= split);
    if (ins.length >= 3 && oos.length >= 3) {
      const a = pfOf(ins), b = pfOf(oos);
      L.push('穩定度：前70% PF ' + fPF(a) + '（' + ins.length + '筆）→ 後30% PF ' + fPF(b) + '（' + oos.length + '筆）' + (isNum(a) && isNum(b) && b < a * 0.7 ? ' ⚠️ 近期績效轉弱' : ''));
    } else L.push('穩定度：前後段交易筆數不足，無法比較');

    // 改進實驗
    const vars = variantsOf(key, base).map(v => { const r = runBT(s, ind, key, v.p, v.o, from).st; return Object.assign({}, v, { st: r }); });
    L.push('──────────────');
    L.push('🔧 改進實驗（同期間、同成本）');
    vars.forEach(v => {
      const x = v.st;
      L.push('• ' + v.name + (x.n ? '：' + x.n + '筆｜勝率' + (x.winRate * 100).toFixed(0) + '%｜PF ' + fPF(x.pf) + '｜MDD ' + pct(x.mdd, 0) + '｜報酬 ' + pct(x.total, 0) : '：無交易'));
    });
    const baseScore = st.total / Math.max(0.05, -st.mdd);
    const better = vars.slice(1).filter(v => v.st.n >= Math.max(5, st.n * 0.4) && (v.st.total / Math.max(0.05, -v.st.mdd)) > baseScore * 1.1);
    better.sort((a, b) => (b.st.total / Math.max(0.05, -b.st.mdd)) - (a.st.total / Math.max(0.05, -a.st.mdd)));
    L.push('──────────────');
    L.push('💡 具體改進方向');
    const tips = [];
    if (better.length) { const b = better[0].st; tips.push('優先採用「' + better[0].name.replace(/^＋/, '') + '」：報酬/回撤比 ' + (baseScore).toFixed(1) + ' → ' + (b.total / Math.max(0.05, -b.mdd)).toFixed(1) + '，MDD ' + pct(st.mdd, 0) + ' → ' + pct(b.mdd, 0) + '。'); }
    else tips.push('上面幾種常見優化在這檔上沒有明顯改善（報酬/回撤比未提升10%以上），不要為了好看硬加條件。');
    if (st.winRate < 0.4 && isNum(st.avgWin) && isNum(st.avgLoss) && st.avgLoss < 0 && st.avgWin / -st.avgLoss >= 2) tips.push('勝率低但賺賠比約 ' + (st.avgWin / -st.avgLoss).toFixed(1) + '：典型趨勢型，重點是嚴守停損、別因連續小賠放棄。');
    if (st.winRate >= 0.6 && isNum(st.pf) && st.pf < 1.3) tips.push('勝率高但PF偏低＝小賺大賠：加停損（如2.5×ATR）或縮短持有，砍掉少數大虧。');
    if (st.n < 15) tips.push('只有 ' + st.n + ' 筆，樣本偏少：拉長到5年、或同產業多檔交叉驗證再下結論。');
    if (ins.length >= 3 && oos.length >= 3 && isNum(pfOf(ins)) && isNum(pfOf(oos)) && pfOf(oos) < pfOf(ins) * 0.7) tips.push('近期績效比前段差30%以上，可能市場風格改變，上線前先小額驗證。');
    if (st.mdd < -0.25) tips.push('最大回撤超過25%：單筆風險壓在總資金1–2%、加上ATR停損，並考慮大盤轉空時停用。');
    if (isNum(st.avgRet) && st.avgRet < 0.006 && st.n > 20) tips.push('平均每筆只賺 ' + pct(st.avgRet, 2) + '，手續費＋稅就吃掉大半：降低交易頻率或改用較長週期。');
    if (st.total < st.bh.total) {
      if (st.mdd > st.bh.mdd) tips.push('報酬輸給買進持有（' + pct(st.total, 0) + ' vs ' + pct(st.bh.total, 0) + '），但回撤較小（' + pct(st.mdd, 0) + ' vs ' + pct(st.bh.mdd, 0) + '）：它的價值在「少受罪」，要比的是報酬/回撤，不是絕對報酬。');
      else tips.push('報酬與回撤都輸給買進持有（' + pct(st.total, 0) + '／' + pct(st.mdd, 0) + ' vs ' + pct(st.bh.total, 0) + '／' + pct(st.bh.mdd, 0) + '）：這個策略在這檔上沒有優勢，考慮改策略或直接長抱。');
    }
    tips.slice(0, 5).forEach((t, i) => L.push((i + 1) + '. ' + t));
    L.push('※ 以上為歷史模擬，同一份資料調參數會有過度配適風險；不代表未來績效。');
    return [L.join('\n')];
  }

  // ───────────────────────── 投資組合分析 ─────────────────────────
  const SECTOR = {
    '2330': '半導體', '2303': '半導體', '2454': '半導體', '3711': '半導體', '2379': '半導體', '3034': '半導體', '6770': '半導體', '8299': '半導體', '3008': '光學',
    '2408': '記憶體', '2344': '記憶體', '2317': 'AI伺服器/代工', '2382': 'AI伺服器/代工', '6669': 'AI伺服器/代工', '3231': 'AI伺服器/代工', '2357': 'AI伺服器/代工', '2376': 'AI伺服器/代工', '2377': 'AI伺服器/代工', '4938': 'AI伺服器/代工',
    '2308': '電源零組件', '2327': '被動元件', '2368': 'PCB', '2313': 'PCB', '6269': 'PCB', '3037': 'PCB', '3017': '散熱', '3324': '散熱', '2345': '網通', '3380': '網通', '2332': '網通',
    '2881': '金融', '2882': '金融', '2883': '金融', '2884': '金融', '2885': '金融', '2886': '金融', '2887': '金融', '2890': '金融', '2891': '金融', '2892': '金融', '5880': '金融', '5871': '金融',
    '2603': '航運', '2609': '航運', '2615': '航運', '2618': '航空', '2610': '航空',
    '1301': '塑化', '1303': '塑化', '1326': '塑化', '6505': '塑化', '1101': '水泥', '2002': '鋼鐵',
    '2412': '電信', '3045': '電信', '4904': '電信', '2409': '面板', '3481': '面板', '2474': '機殼',
    '1216': '食品', '2912': '零售', '2207': '汽車', '3491': '低軌衛星', '6285': '低軌衛星',
    '0050': '大盤ETF', '006208': '大盤ETF', '00631L': '大盤ETF', '00632R': '反向ETF',
    '0056': '高股息ETF', '00878': '高股息ETF', '00919': '高股息ETF', '00929': '高股息ETF', '00940': '高股息ETF', '00881': '高股息ETF',
    'AAPL': '美股科技', 'MSFT': '美股科技', 'NVDA': '美股科技', 'AMD': '美股科技', 'GOOGL': '美股科技', 'META': '美股科技', 'AMZN': '美股科技', 'TSLA': '美股科技', 'AVGO': '美股科技'
  };
  const NO_SECTOR_CAP = new Set(['大盤ETF', '高股息ETF', '反向ETF']);
  const PROFILES = {
    '保守': { single: 0.15, sector: 0.30, cash: 0.20, vol: 0.12, lossTol: 0.08, hedge: 0.5 },
    '中等': { single: 0.25, sector: 0.40, cash: 0.10, vol: 0.18, lossTol: 0.12, hedge: 0.3 },
    '積極': { single: 0.35, sector: 0.55, cash: 0.05, vol: 0.25, lossTol: 0.16, hedge: 0.2 }
  };
  const TSMC_ETF = new Set(['0050', '006208', '00631L']);
  const PF_USAGE = '用法：組合 標的 比例 … [現金 比例] [保守/中等/積極] [資金300萬]\n例：\n組合 2330:40 0050:30 2454:20 現金:10 中等\n組合 2330:40 2881:30 2603:30 保守 資金200萬\n組合 自選　（自選股等權重）\n沒寫風險承受度預設「中等」。';

  function parsePortfolio(rest) {
    const s = String(rest || '').replace(/[％%]/g, ' ').replace(/[:：=,，、]/g, ' ').trim();
    const toks = s.split(/\s+/).filter(Boolean);
    let risk = '中等', capital = null, cash = 0, useWatch = false; const holds = [];
    const wRe = /^(?:100|\d{1,2}(?:\.\d+)?)$/;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]; let m;
      if (/^(保守|穩健|中等|積極)$/.test(t)) { risk = t === '穩健' ? '中等' : t; continue; }
      if ((m = t.match(/^資金(\d+(?:\.\d+)?)萬?$/)) || (m = t.match(/^(\d+(?:\.\d+)?)萬$/))) { capital = parseFloat(m[1]) * 10000; continue; }
      if (t === '資金' && toks[i + 1] && /^\d+(\.\d+)?萬?$/.test(toks[i + 1])) { capital = parseFloat(toks[i + 1]) * 10000; i++; continue; }
      if (t === '自選' || t === '自選股') { useWatch = true; continue; }
      if (t === '現金') { if (toks[i + 1] && wRe.test(toks[i + 1])) { cash = parseFloat(toks[i + 1]); i++; } continue; }
      if (toks[i + 1] && wRe.test(toks[i + 1])) { holds.push({ q: t, w: parseFloat(toks[i + 1]) }); i++; }
      else return { error: '看不懂「' + t + '」：請用「代號 比例」，例如 2330 40' };
    }
    return { risk, capital, cash, useWatch, holds };
  }
  function covMatrix(rets) {
    const k = rets.length, T = rets[0].length, mu = rets.map(avg);
    const cov = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < k; i++) for (let j = i; j < k; j++) {
      let s = 0; for (let t = 0; t < T; t++) s += (rets[i][t] - mu[i]) * (rets[j][t] - mu[j]);
      cov[i][j] = cov[j][i] = s / (T - 1) * 252;
    }
    return cov;
  }
  function portVol(w, cov) { let v = 0; for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) v += w[i] * w[j] * cov[i][j]; return Math.sqrt(Math.max(v, 0)); }
  function sectorOf(code, info) { return SECTOR[code] || (info && info.kind === 'us' ? '美股' : '其他(' + code + ')'); }

  function rebalance(w, cash, codes, sectors, vols, prof) {
    const k = w.length;
    const capOf = i => Math.min(0.6, prof.single * (isETF(codes[i]) ? 1.6 : 1));
    let tcash = Math.max(cash, prof.cash);
    let tw = w.slice();
    const eqSum = sum(tw), room = 1 - tcash;
    if (eqSum > room) tw = tw.map(x => x * room / eqSum);
    const invVol = vols.map(v => 1 / Math.max(v, 0.05));
    for (let it = 0; it < 30; it++) {
      let excess = 0;
      tw = tw.map((x, i) => { const cp = capOf(i); if (x > cp + 1e-9) { excess += x - cp; return cp; } return x; });
      const secSum = {}; tw.forEach((x, i) => { secSum[sectors[i]] = (secSum[sectors[i]] || 0) + x; });
      for (const sec of Object.keys(secSum)) {
        if (NO_SECTOR_CAP.has(sec) || secSum[sec] <= prof.sector + 1e-9) continue;
        const f = prof.sector / secSum[sec];
        tw = tw.map((x, i) => { if (sectors[i] !== sec) return x; excess += x * (1 - f); return x * f; });
      }
      if (excess < 1e-6) break;
      const secSum2 = {}; tw.forEach((x, i) => { secSum2[sectors[i]] = (secSum2[sectors[i]] || 0) + x; });
      const elig = tw.map((x, i) => (x < capOf(i) - 1e-6 && (NO_SECTOR_CAP.has(sectors[i]) || secSum2[sectors[i]] < prof.sector - 1e-6) && codes[i] !== '00632R') ? i : -1).filter(i => i >= 0);
      if (!elig.length) break;
      const tot = sum(elig.map(i => invVol[i]));
      elig.forEach(i => { const room2 = Math.min(capOf(i) - tw[i], NO_SECTOR_CAP.has(sectors[i]) ? 1 : prof.sector - secSum2[sectors[i]]); tw[i] += Math.max(0, Math.min(excess * invVol[i] / tot, room2)); });
    }
    return tw;
  }

  async function cmdPortfolio(rest, ctx) {
    const pr = parsePortfolio(rest);
    if (pr.error) return [pr.error + '\n\n' + PF_USAGE];
    let holds = pr.holds, cashPct = pr.cash;
    if (pr.useWatch || !holds.length) {
      const wl = (await getWatchlist(ctx.uid)).slice(0, 10);
      if (!wl.length) return [PF_USAGE];
      holds = wl.map(c => ({ q: c, w: 100 / wl.length })); cashPct = 0;
    }
    if (holds.length > 10) return ['⚠️ 最多支援10檔'];
    const merged = {};
    for (const h of holds) {
      let info = resolveSymbol(h.q);
      if (!info) { const c = findCodeByName(h.q); if (c) info = resolveSymbol(c); }
      if (!info || info.kind === 'index') return ['⚠️ 找不到標的「' + h.q + '」，請改用股票代號。\n\n' + PF_USAGE];
      merged[info.code] = (merged[info.code] || 0) + h.w;
    }
    const codes = Object.keys(merged);
    if (codes.length < 2) return ['⚠️ 至少要2檔才能算相關性。\n\n' + PF_USAGE];
    const total = sum(codes.map(c => merged[c])) + cashPct;
    if (total <= 0) return [PF_USAGE];
    let w = codes.map(c => merged[c] / total); const cash = cashPct / total;
    const normNote = Math.abs(total - 100) > 1 ? '（你輸入的比例合計 ' + total.toFixed(0) + '%，已換算成100%）' : '';

    const series = [];
    for (const c of codes) series.push(await getHistory(c, '1y'));
    let mk = null; try { mk = await getHistory('加權', '1y'); } catch (e) { mk = null; }
    const dayKey = t => Math.floor((t + 28800) / 86400);
    const maps = series.map(s => { const m = new Map(); s.t.forEach((t, i) => m.set(dayKey(t), s.c[i])); return m; });
    const days = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort((a, b) => a - b);
    if (days.length < 60) throw new Error('各標的共同交易日不足60天（混合市場或新上市標的？）');
    const closes = maps.map(m => days.map(d => m.get(d)));
    const rets = closes.map(cs => cs.slice(1).map((x, i) => x / cs[i] - 1));
    let mret = null;
    if (mk) {
      const mm = new Map(); mk.t.forEach((t, i) => mm.set(dayKey(t), mk.c[i]));
      let last = null; const first = mk.c[0];
      const mc = days.map(d => { if (mm.has(d)) last = mm.get(d); return last == null ? first : last; });
      mret = mc.slice(1).map((x, i) => x / mc[i] - 1);
    }
    const k = codes.length, cov = covMatrix(rets);
    const vols = codes.map((_, i) => Math.sqrt(cov[i][i]));
    const infos = series.map(s => s.info);
    const names = []; for (let i = 0; i < k; i++) names.push(await nameOf(codes[i], series[i]));
    const lab = i => codes[i] + (names[i] ? names[i] : '');
    const sectors = codes.map((c, i) => sectorOf(c, infos[i]));
    const prof = PROFILES[pr.risk];

    const sig = portVol(w, cov);
    const margin = codes.map((_, i) => sum(w.map((wj, j) => cov[i][j] * wj)));
    const rc = codes.map((_, i) => (sig > 0 ? w[i] * margin[i] / (sig * sig) : 0));
    let betas = codes.map(() => null);
    if (mret) {
      const mm = avg(mret); const vm = sum(mret.map(x => (x - mm) ** 2)) / (mret.length - 1);
      betas = rets.map(r => { const mr = avg(r); return sum(r.map((x, t) => (x - mr) * (mret[t] - mm))) / (r.length - 1) / vm; });
    }
    const betaP = mret ? sum(w.map((x, i) => x * betas[i])) : null;
    const pr_t = rets[0].map((_, t) => sum(w.map((x, i) => x * rets[i][t])));
    let eqv = 1, peak = 1, mdd = 0; const curve = [1];
    pr_t.forEach(r => { eqv *= 1 + r; curve.push(eqv); if (eqv > peak) peak = eqv; mdd = Math.min(mdd, eqv / peak - 1); });
    let worst20 = 0; for (let t = 20; t < curve.length; t++) worst20 = Math.min(worst20, curve[t] / curve[t - 20] - 1);
    const effN = 1 / sum(w.map(x => x * x));
    const corr = (i, j) => cov[i][j] / (vols[i] * vols[j]);
    const pairs = []; for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) pairs.push({ i, j, r: corr(i, j) });
    pairs.sort((a, b) => b.r - a.r);
    const avgCorr = avg(pairs.map(p => p.r));
    const secW = {}; w.forEach((x, i) => { secW[sectors[i]] = (secW[sectors[i]] || 0) + x; });

    const weak = [];
    series.forEach((s, i) => {
      const c = s.c, n = c.length, m60 = sma(c, 60), L = m60[n - 1], P10 = m60[n - 11];
      const dd = c[n - 1] / Math.max(...c) - 1;
      const reasons = [];
      if (L != null && P10 != null && c[n - 1] < L && L < P10) reasons.push('跌破下彎的季線');
      if (dd < -0.2) reasons.push('距1年高點 ' + pct(dd, 0));
      if (reasons.length) weak.push(lab(i) + '：' + reasons.join('、'));
    });

    // ── 訊息1：現況診斷
    const M1 = ['📊 投資組合診斷｜風險承受度：' + pr.risk + (normNote ? '\n' + normNote : '')];
    M1.push('配置：' + codes.map((c, i) => lab(i) + ' ' + (w[i] * 100).toFixed(0) + '%').join('、') + (cash > 0 ? '、現金 ' + (cash * 100).toFixed(0) + '%' : ''));
    M1.push('近1年：年化波動 ' + (sig * 100).toFixed(1) + '%｜最大回撤 ' + pct(mdd, 1) + '｜最差20日 ' + pct(worst20, 1) + (betaP !== null ? '｜Beta ' + betaP.toFixed(2) : '') + '｜有效持股數 ' + effN.toFixed(1));
    M1.push('──────────────');
    M1.push('🔴 過度曝險');
    const over = [];
    codes.forEach((c, i) => { const cp = Math.min(0.6, prof.single * (isETF(c) ? 1.6 : 1)); if (w[i] > cp + 0.005) over.push('單一標的 ' + lab(i) + ' ' + (w[i] * 100).toFixed(0) + '% > 上限 ' + (cp * 100).toFixed(0) + '%'); });
    Object.keys(secW).forEach(sec => { if (!NO_SECTOR_CAP.has(sec) && secW[sec] > prof.sector + 0.005) over.push('產業「' + sec + '」合計 ' + (secW[sec] * 100).toFixed(0) + '% > 上限 ' + (prof.sector * 100).toFixed(0) + '%'); });
    codes.forEach((c, i) => { if (rc[i] - w[i] > 0.1) over.push(lab(i) + ' 佔資金 ' + (w[i] * 100).toFixed(0) + '% 卻貢獻 ' + (rc[i] * 100).toFixed(0) + '% 的組合風險（高波動）'); });
    if (cash < prof.cash - 0.005) over.push('現金僅 ' + (cash * 100).toFixed(0) + '%，低於「' + pr.risk + '」建議的 ' + (prof.cash * 100).toFixed(0) + '%');
    if (sig > prof.vol) over.push('年化波動 ' + (sig * 100).toFixed(0) + '% 高於「' + pr.risk + '」目標 ' + (prof.vol * 100).toFixed(0) + '%');
    M1.push(over.length ? over.map(x => '• ' + x).join('\n') : '• 沒有明顯超標');
    M1.push('🔗 隱藏相關性');
    const hi = pairs.filter(p => p.r >= 0.7).slice(0, 4);
    if (hi.length) hi.forEach(p => M1.push('• ' + lab(p.i) + ' × ' + lab(p.j) + '：相關係數 ' + p.r.toFixed(2) + '（同漲同跌，分散效果有限）'));
    else M1.push('• 沒有相關係數≥0.7 的組合，分散度尚可');
    M1.push('• 平均兩兩相關 ' + avgCorr.toFixed(2) + (avgCorr > 0.6 ? '（偏高，崩盤時會一起跌）' : ''));
    if (codes.some(c => TSMC_ETF.has(c)) && codes.includes('2330')) M1.push('• 你同時持有台積電與大盤型ETF（0050/006208等），ETF成分大量重疊台積電，實際台積電曝險比表面比例更高');
    M1.push('⚠️ 弱點');
    const wk = [];
    if (weak.length) weak.forEach(x => wk.push(x));
    const worstRC = codes.map((c, i) => ({ i, v: rc[i] })).sort((a, b) => b.v - a.v)[0];
    wk.push('風險集中：' + lab(worstRC.i) + ' 貢獻組合約 ' + (worstRC.v * 100).toFixed(0) + '% 的波動');
    if (effN < 4) wk.push('有效持股數只有 ' + effN.toFixed(1) + '，等同只買了 ' + Math.round(effN) + ' 檔');
    if (mdd < -0.15) wk.push('近一年最大回撤 ' + pct(mdd, 0) + '，你要能承受這種幅度');
    M1.push(wk.map(x => '• ' + x).join('\n'));
    M1.push('※ 相關性與波動以近1年日報酬估算；崩盤時相關性通常上升。');

    // ── 訊息2：再平衡
    const tw = rebalance(w, cash, codes, sectors, vols, prof);
    let tcash = 1 - sum(tw);
    let sig2 = portVol(tw, cov);
    if (sig2 > prof.vol && sig2 > 0) { const f = Math.max(0.4, prof.vol / sig2); const tw2 = tw.map(x => x * f); tcash = 1 - sum(tw2); for (let i = 0; i < k; i++) tw[i] = tw2[i]; sig2 = portVol(tw, cov); }
    const betaP2 = mret ? sum(tw.map((x, i) => x * betas[i])) : null;
    const cap = pr.capital;
    const money = x => (cap ? '（約 NT$' + Math.round(Math.abs(x) * cap / 1000) * 1000 / 10000 + '萬）' : '');
    const M2 = ['⚖️ 再平衡方案（' + pr.risk + '）', '規則：單一標的≤' + (prof.single * 100).toFixed(0) + '%（ETF放寬）、單一產業≤' + (prof.sector * 100).toFixed(0) + '%、現金≥' + (prof.cash * 100).toFixed(0) + '%、年化波動≤' + (prof.vol * 100).toFixed(0) + '%', '──────────────'];
    const moves = codes.map((c, i) => ({ i, d: tw[i] - w[i] })).sort((a, b) => a.d - b.d);
    moves.forEach(m => {
      const i = m.i;
      const act = Math.abs(m.d) < 0.01 ? '維持' : m.d < 0 ? '減碼 ' + (-m.d * 100).toFixed(0) + '%' : '加碼 ' + (m.d * 100).toFixed(0) + '%';
      M2.push((m.d < -0.01 ? '🔻 ' : m.d > 0.01 ? '🔺 ' : '▫️ ') + lab(i) + '：' + (w[i] * 100).toFixed(0) + '% → ' + (tw[i] * 100).toFixed(0) + '%（' + act + '）' + (Math.abs(m.d) >= 0.01 ? money(m.d) : ''));
    });
    M2.push('💵 現金：' + (cash * 100).toFixed(0) + '% → ' + (tcash * 100).toFixed(0) + '%' + money(tcash - cash));
    M2.push('──────────────');
    M2.push('調整後：年化波動 ' + (sig * 100).toFixed(1) + '% → ' + (sig2 * 100).toFixed(1) + '%' + (betaP !== null ? '｜Beta ' + betaP.toFixed(2) + ' → ' + betaP2.toFixed(2) : ''));
    if (weak.length) M2.push('📌 弱勢標的（' + weak.map(x => x.split('：')[0]).join('、') + '）：建議先減碼一半，等站回季線再加回。');
    if (moves.every(m => Math.abs(m.d) < 0.01) && Math.abs(tcash - cash) < 0.01) M2.push('✅ 目前配置已落在「' + pr.risk + '」範圍內，不需要大幅調整。');
    M2.push('執行：分3批、跨3–5個交易日調整，避免一次性追價；考量交易成本與稅，微幅偏離（<3%）可不動。');

    // ── 訊息3：避險
    const shock = 0.2;
    const M3 = ['🛡️ 大盤下跌20%的避險策略'];
    if (betaP === null) { M3.push('（加權指數資料取得失敗，無法估算Beta，僅提供一般原則）'); }
    else {
      const loss1 = betaP * shock, loss2 = betaP2 * shock;
      M3.push('壓力測試（大盤-20%，依Beta估算）：現況約 ' + pct(-loss1, 1) + (cap ? '（約 -NT$' + Math.round(loss1 * cap / 10000) + '萬）' : '') + '｜再平衡後約 ' + pct(-loss2, 1) + (cap ? '（約 -NT$' + Math.round(loss2 * cap / 10000) + '萬）' : ''));
      const hurt = codes.map((c, i) => ({ i, v: w[i] * betas[i] * shock })).sort((a, b) => b.v - a.v).slice(0, 3);
      M3.push('最傷的3檔：' + hurt.map(h => lab(h.i) + ' ' + pct(-h.v, 1)).join('、') + '（佔組合）');
      M3.push('※ 崩盤時個股跌幅常大於Beta推估，把它當下限。');
      const tolBeta = prof.lossTol / shock;
      const need = Math.max(0, betaP2 - tolBeta);
      M3.push('──────────────');
      M3.push('你的容忍：' + pr.risk + '型約能承受組合 ' + (prof.lossTol * 100).toFixed(0) + '% 虧損 → 目標Beta ≤ ' + tolBeta.toFixed(2));
      if (need <= 0.01) M3.push('✅ 再平衡後Beta已在容忍範圍內，可只做「紀律型」保護（見下方 D）。');
      else {
        const hedgeN = need; // 需要對沖的指數曝險（佔組合比例）＝Beta需下降的幅度
        const idx = mk ? mk.c[mk.c.length - 1] : null;
        const base = cap || 1000000;
        const notional = hedgeN * base;
        M3.push('需對沖的指數曝險 ≈ 組合的 ' + (hedgeN * 100).toFixed(0) + '%' + (cap ? '（約 NT$' + Math.round(notional / 10000) + '萬）' : '（以資金100萬為例＝' + Math.round(notional / 10000) + '萬）'));
        M3.push('A. 降部位（最簡單、無追繳風險）：股票再降約 ' + (hedgeN / Math.max(0.3, betaP2 / Math.max(1e-6, 1 - tcash)) * 100).toFixed(0) + ' 個百分點（占組合）轉現金/短天期債。');
        M3.push('B. 反向ETF 00632R：買入約 ' + (hedgeN * 100).toFixed(0) + '% 組合價值' + (cap ? '（NT$' + Math.round(notional / 10000) + '萬）' : '') + '。每日重設，只適合持有1–4週的短期對沖，長抱會耗損。');
        if (idx) {
          const mtx = notional / (idx * 50), tmf = notional / (idx * 10);
          const oneTmf = idx * 10;
          if (tmf < 0.5) {
            M3.push('C. 台指期空單：不適用。微型台指1口名目約 NT$' + Math.round(oneTmf / 10000) + '萬（加權 ' + Math.round(idx).toLocaleString('en-US') + '），已超過需對沖的 NT$' + Math.round(notional / 10000) + '萬，放空1口會過度對沖。資金約 ' + Math.round(oneTmf / hedgeN / 10000) + ' 萬以上再考慮，現階段用 A 或 B。');
          } else {
            M3.push('C. 台指期空單：' + (mtx >= 1 ? '小型台指(1點50元)約 ' + Math.round(mtx) + ' 口，或' : '') + '微型台指(1點10元)約 ' + Math.max(1, Math.round(tmf)) + ' 口（加權 ' + Math.round(idx).toLocaleString('en-US') + '）。要備保證金與追繳資金，行情反彈時期貨會虧。');
          }
        }
        M3.push('D. 買進價外Put：台指選擇權履約價約低於現價5–8%，口數同上；最大損失＝權利金（先查當下報價與隱含波動）。');
      }
      M3.push('E. 紀律（不花錢）：個股停損 -8%～-10% 或跌破季線減碼；大盤跌破季線先減 20–30%；保留的現金分3批在 -10%/-15%/-20% 承接。');
    }
    M3.push('──────────────');
    M3.push('※ 以上為歷史統計與一般原則，不是投資建議，期貨選擇權有高槓桿風險，請依自身狀況評估。');
    return [M1.join('\n'), M2.join('\n'), M3.join('\n')];
  }

  // ───────────────────────── 指令分派 ─────────────────────────
  function toMsgs(strs) {
    const out = [];
    for (const s of strs) {
      let t = String(s);
      while (t.length > 4800) { let cut = t.lastIndexOf('\n', 4800); if (cut < 1000) cut = 4800; out.push({ type: 'text', text: t.slice(0, cut) }); t = t.slice(cut); }
      if (t.trim()) out.push({ type: 'text', text: t });
    }
    return out;
  }
  async function sendReply(ctx, strs) {
    const m = toMsgs(strs);
    await replyOrPush(ctx.replyToken, ctx.uid, m.slice(0, 5));
    if (m.length > 5) await push(ctx.uid, m.slice(5, 10));
  }
  async function showLoading(uid) {
    try {
      await axios.post('https://api.line.me/v2/bot/chat/loading/start', { chatId: uid, loadingSeconds: 60 },
        { headers: { Authorization: 'Bearer ' + LINE_TOKEN, 'Content-Type': 'application/json' }, timeout: 5000 });
    } catch (e) { /* 群組或舊版不支援，略過 */ }
  }
  const busy = new Set();
  async function guarded(ctx, label, fn) {
    if (busy.has(ctx.uid)) { await sendReply(ctx, ['⏳ 上一個分析還在跑，請稍等它完成再下指令']); return; }
    busy.add(ctx.uid);
    await showLoading(ctx.uid);
    try { await sendReply(ctx, await fn()); }
    catch (e) { console.log(label + ' 失敗:', e.message); await sendReply(ctx, ['❌ ' + label + '失敗：' + (e.message || '未知錯誤') + '\n請稍後再試']); }
    finally { busy.delete(ctx.uid); }
  }

  const HELP_ADDON = '\n🚀 進階分析：\n機會 掃描今日5個交易機會（進場/目標/停損）\n技術 2330 日線+週線：支撐壓力、趨勢線、均線、動能、買/觀望/賣流程\n消息 台積電（或 PCB、航運）消息影響+波動區間\n回測 2330 均線 3年 策略回測+改進建議\n組合 2330:40 0050:30 現金:30 中等 持股診斷+再平衡+避險';

  async function handle(txt, ctx) {
    let m;
    if (/^(機會|機會掃描|掃描|找機會)$/.test(txt)) { await guarded(ctx, '機會掃描', () => cmdScan(ctx.uid)); return true; }
    if (/^(技術|日週線|週線|日線|趨勢)$/.test(txt)) { await sendReply(ctx, ['用法：技術 代號\n例：技術 2330、技術 AAPL、技術 加權']); return true; }
    if ((m = txt.match(/^(?:技術|日週線|週線|日線|趨勢)\s+(.+)$/))) {
      let input = m[1].trim(); if (!resolveSymbol(input)) { const c = findCodeByName(input); if (c) input = c; }
      await guarded(ctx, '技術分析', () => cmdTech(input)); return true;
    }
    if (/^消息$/.test(txt)) { await sendReply(ctx, ['用法：消息 公司/產業\n例：消息 台積電、消息 PCB、消息 航運']); return true; }
    if ((m = txt.match(/^消息\s+(.+)$/))) { await guarded(ctx, '消息分析', () => cmdNews(m[1])); return true; }
    if (/^回測$/.test(txt)) { await sendReply(ctx, [BT_USAGE]); return true; }
    if ((m = txt.match(/^回測\s+(.+)$/))) { await guarded(ctx, '回測', () => cmdBacktest(m[1])); return true; }
    if ((m = txt.match(/^組合(?:\s+(.+))?$/))) {
      if (!m[1]) { await sendReply(ctx, [PF_USAGE]); return true; }
      await guarded(ctx, '組合分析', () => cmdPortfolio(m[1], ctx)); return true;
    }
    return false;
  }

  return {
    handle, helpAddon: HELP_ADDON,
    _t: { parseFinmind, sma, ema, rsiSeries, macdSeries, atrSeries, kdSeries, bollSeries, findPivots, analyzeFrame, decide, frameText, flowText, toWeekly, prepInd, runBT, buildStrat, parseBT, parsePortfolio, parseNewsXml, rebalance, covMatrix, portVol, resolveSymbol, findCodeByName, cmdTech, cmdBacktest, cmdPortfolio, cmdNews, cmdScan, techOf, _setHistory: (key, data) => histCache.set(key, { at: Date.now() + 1e12, data }) }
  };
};
