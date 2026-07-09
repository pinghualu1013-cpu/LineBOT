const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TW_NAMES = {
  '0050':'元大台灣50','0056':'元大高股息','00878':'國泰永續高股息',
  '00881':'國泰台灣ESG永續','00919':'群益台灣精選高息','00929':'復華台灣科技優息',
  '00940':'元大台灣價值高息','00631L':'元大台灣50正2','00632R':'元大台灣50反1',
  '1101':'台泥','1216':'統一','1301':'台塑','1303':'南亞','1326':'台化',
  '2002':'中鋼','2207':'和泰車','2303':'聯電','2308':'台達電','2317':'鴻海',
  '2327':'國巨','2330':'台積電','2357':'華碩','2376':'技嘉','2377':'微星',
  '2379':'瑞昱','2382':'廣達','2395':'研華','2408':'南亞科','2409':'友達',
  '2412':'中華電','2454':'聯發科','2474':'可成','2603':'長榮','2609':'陽明',
  '2610':'華航','2615':'萬海','2618':'長榮航','2881':'富邦金','2882':'國泰金',
  '2883':'開發金','2884':'玉山金','2885':'元大金','2886':'兆豐金','2887':'台新金',
  '2890':'永豐金','2891':'中信金','2892':'第一金','2912':'統一超','3008':'大立光',
  '3034':'聯詠','3045':'台灣大','4904':'遠傳','4938':'和碩','5871':'中租-KY',
  '5880':'合庫金','6505':'台塑化','6669':'緯穎','6770':'力積電','8299':'群聯'
};

const SB = axios.create({
  baseURL: SUPABASE_URL + '/rest/v1',
  headers: {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  }
});

async function getWatchlist(userId) {
  try {
    const r = await SB.get('/watchlist?user_id=eq.' + userId + '&select=stock_code&order=created_at.asc');
    return r.data.map(row => row.stock_code);
  } catch (e) { return []; }
}

async function addToWatchlist(userId, code) {
  try {
    const existing = await getWatchlist(userId);
    if (existing.includes(code)) return 'exists';
    if (existing.length >= 10) return 'full';
    await SB.post('/watchlist', { user_id: userId, stock_code: code });
    return 'ok';
  } catch (e) { return 'error'; }
}

async function removeFromWatchlist(userId, code) {
  try {
    await SB.delete('/watchlist?user_id=eq.' + userId + '&stock_code=eq.' + code);
    return 'ok';
  } catch (e) { return 'error'; }
}

async function getAllUsers() {
  try {
    const r = await SB.get('/watchlist?select=user_id&order=user_id');
    return [...new Set(r.data.map(row => row.user_id))];
  } catch (e) { return []; }
}

async function push(userId, messages) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/push',
      { to: userId, messages },
      { headers: { Authorization: 'Bearer ' + LINE_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (e) { console.log('push error:', e.message); }
}

async function pushText(userId, text) {
  await push(userId, [{ type: 'text', text }]);
}

async function getYahooData(symbol) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=3mo';
    const r = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const result = r.data.chart.result[0];
    const meta = result.meta;
    const quotes = result.indicators.quote[0];
    const closes = quotes.close;
    const volumes = quotes.volume;
    const timestamps = result.timestamp;
    const price = meta.regularMarketPrice;
    const closesClean = closes.filter(c => c !== null);
    const prev = closesClean.length >= 2 ? closesClean[closesClean.length - 2] : meta.regularMarketPreviousClose;
    const change = price - prev;
    const labels = timestamps.map(ts => {
      const d = new Date(ts * 1000);
      return (d.getMonth() + 1) + '/' + d.getDate();
    });
    return {
      price, change,
      changePct: (change / prev * 100).toFixed(2),
      volume: meta.regularMarketVolume,
      high52: meta.fiftyTwoWeekHigh,
      low52: meta.fiftyTwoWeekLow,
      dayHigh: meta.regularMarketDayHigh,
      dayLow: meta.regularMarketDayLow,
      currency: meta.currency,
      labels,
      closes: closes.map(c => c ? parseFloat(c.toFixed(2)) : null),
      volumes: volumes.map(v => v || 0)
    };
  } catch (e) {
    if (symbol.endsWith('.TW')) {
      try { return await getYahooData(symbol.replace('.TW', '.TWO')); } catch (e2) {}
    }
    return null;
  }
}

function calcMA(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1).filter(c => c !== null);
    if (slice.length < period) return null;
    return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(2));
  });
}

function calcRSI(closes, period) {
  period = period || 14;
  const clean = closes.filter(c => c !== null);
  if (clean.length < period + 1) return null;
  const slice = clean.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return parseFloat((100 - (100 / (1 + (gains / period) / avgLoss))).toFixed(1));
}

function calcEMA(closes, period) {
  const clean = closes.filter(c => c !== null);
  if (clean.length < period) return null;
  const k = 2 / (period + 1);
  let ema = clean.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < clean.length; i++) ema = clean[i] * k + ema * (1 - k);
  return parseFloat(ema.toFixed(2));
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  return parseFloat((ema12 - ema26).toFixed(3));
}

function calcBollinger(closes, period) {
  period = period || 20;
  const clean = closes.filter(c => c !== null);
  if (clean.length < period) return null;
  const slice = clean.slice(-period);
  const ma = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - ma, 2), 0) / period);
  return {
    upper: parseFloat((ma + 2 * std).toFixed(2)),
    middle: parseFloat(ma.toFixed(2)),
    lower: parseFloat((ma - 2 * std).toFixed(2))
  };
}

async function getChartUrl(title, labels, closes, ma5arr, ma20arr, ma60arr) {
  try {
    const n = 30;
    const sl = arr => arr.slice(-n);
    const config = {
      type: 'line',
      data: {
        labels: sl(labels),
        datasets: [
          { label: '收盤價', data: sl(closes), borderColor: '#2196F3', backgroundColor: 'rgba(33,150,243,0.08)', borderWidth: 2, pointRadius: 2, fill: true, tension: 0.1 },
          { label: 'MA5', data: sl(ma5arr), borderColor: '#FF9800', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.1 },
          { label: 'MA20', data: sl(ma20arr), borderColor: '#E91E63', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.1 },
          { label: 'MA60', data: sl(ma60arr), borderColor: '#9C27B0', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.1 }
        ]
      },
      options: {
        title: { display: true, text: title + ' 近30日走勢', fontSize: 16 },
        legend: { position: 'top' },
        scales: { yAxes: [{ ticks: { beginAtZero: false } }], xAxes: [{ ticks: { maxTicksLimit: 10 } }] }
      }
    };
    const qcRes = await axios.post('https://quickchart.io/chart/create',
      { chart: config, width: 600, height: 400, backgroundColor: 'white', format: 'png' },
      { timeout: 10000 }
    );
    return qcRes.data && qcRes.data.url ? qcRes.data.url : null;
  } catch (e) { return null; }
}

async function getTWChipData(code) {
  try {
    const url = 'https://www.twse.com.tw/rwd/zh/fund/T86?response=json&selectType=ALLBUT0999';
    const r = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.data || !r.data.data) return null;
    const row = r.data.data.find(item => item[0] === code);
    if (!row) return null;
    const parseNum = s => parseInt((s || '0').replace(/,/g, '')) || 0;
    return {
      foreign: parseNum(row[4]),
      invest: parseNum(row[7]),
      dealer: parseNum(row[10]),
      total: parseNum(row[11])
    };
  } catch (e) { return null; }
}

function formatChip(chip) {
  if (!chip) return null;
  const fmt = n => {
    const sign = n >= 0 ? '+' : '';
    const arrow = n >= 0 ? '\u25B2' : '\u25BC';
    return sign + n.toLocaleString() + ' \u5F35 ' + arrow;
  };
  return '\u{1F3E6} \u7C4C\u78BC\u9762\uFF08\u4E09\u5927\u6CD5\u4EBA\uFF09\n\u5916\u8CC7\u3000\uFF1A' + fmt(chip.foreign) + '\n\u6295\u4FE1\u3000\uFF1A' + fmt(chip.invest) + '\n\u81EA\u71DF\u5546\uFF1A' + fmt(chip.dealer) + '\n\u5408\u8A08\u3000\uFF1A' + fmt(chip.total);
}

function calcSupportResistance(price, ma5, ma20, ma60, boll, high52, low52) {
  const resistances = [];
  const supports = [];
  if (high52 && high52 > price) resistances.push({ price: high52, label: '52\u9031\u9AD8\u9EDE' });
  if (boll && boll.upper > price) resistances.push({ price: boll.upper, label: '\u5E03\u6797\u4E0A\u8ECC' });
  if (ma5 && ma5 > price) resistances.push({ price: ma5, label: 'MA5' });
  if (ma20 && ma20 > price) resistances.push({ price: ma20, label: 'MA20' });
  if (ma60 && ma60 > price) resistances.push({ price: ma60, label: 'MA60' });
  if (ma5 && ma5 < price) supports.push({ price: ma5, label: 'MA5' });
  if (ma20 && ma20 < price) supports.push({ price: ma20, label: 'MA20' });
  if (ma60 && ma60 < price) supports.push({ price: ma60, label: 'MA60' });
  if (boll && boll.middle < price) supports.push({ price: boll.middle, label: '\u5E03\u6797\u4E2D\u8ECC' });
  if (boll && boll.lower < price) supports.push({ price: boll.lower, label: '\u5E03\u6797\u4E0B\u8ECC' });
  if (low52 && low52 < price) supports.push({ price: low52, label: '52\u9031\u4F4E\u9EDE' });
  resistances.sort((a, b) => a.price - b.price);
  supports.sort((a, b) => b.price - a.price);
  let result = '\u{1F3AF} \u652F\u6490\u58D3\u529B\u5206\u6790\n';
  resistances.slice(0, 2).reverse().forEach(r => { result += '\u{1F534} \u58D3\u529B\uFF1A' + r.price.toFixed(2) + '\uFF08' + r.label + '\uFF09\n'; });
  result += '\u25B6 \u73FE\u50F9\uFF1A' + price.toFixed(2) + '\n';
  supports.slice(0, 2).forEach(s => { result += '\u{1F7E2} \u652F\u6490\uFF1A' + s.price.toFixed(2) + '\uFF08' + s.label + '\uFF09\n'; });
  if (resistances.length > 0 && supports.length > 0) {
    result += '\n\u{1F4CC} \u8DDD\u58D3\u529B +' + ((resistances[0].price - price) / price * 100).toFixed(1) + '%\u3000\u8DDD\u652F\u6490 -' + ((price - supports[0].price) / price * 100).toFixed(1) + '%';
  }
  return result;
}

async function askGroq(techData) {
  const prompt = '\u4F60\u662F\u80A1\u7968\u8001\u5E2B\uFF0C\u8ACB\u7528\u53E3\u8A9E\u5316\u3001\u6DFA\u985E\u6613\u61C2\u7684\u7E41\u9AD4\u4E2D\u6587\u89E3\u91CB\u4EE5\u4E0B\u6280\u8853\u6307\u6A19\uFF0C\u50CF\u5728\u8DE9\u670B\u53CB\u8AAA\u8A71\u4E00\u6A23\uFF0C180\u5B57\u5167\u3002\n\n' + techData + '\n\n\u8ACB\u4F9D\u683C\u5F0F\u56DE\u8986\uFF1A\n\u{1F4B9} \u4ECA\u65E5\u8D70\u52E2\uFF08\u4E00\u53E5\u8A71\uFF09\n\u{1F4CA} \u5747\u7DDA\u6392\u5217\uFF08\u8AAA\u591A\u982D/\u7A7A\u982D/\u7CE0\u7D50\uFF0C\u767D\u8A71\u89E3\u91CB\uFF09\n\u{1F525} RSI\u5F37\u5F31\uFF08\u8D85\u8CB7/\u8D85\u8CE3/\u6B63\u5E38\uFF0C\u7D66\u5EFA\u8B70\uFF09\n\u{1F4C9} MACD\u52D5\u80FD\uFF08\u5F80\u4E0A/\u5F80\u4E0B\uFF0C\u4EE3\u8868\u4EC0\u9EBC\uFF09\n\u{1F3AF} \u5E03\u6797\u4F4D\u7F6E\uFF08\u5728\u54EA\u500B\u5340\u9593\uFF0C\u4EE3\u8868\u4EC0\u9EBC\uFF09\n\u{1F9E0} \u7D9C\u5408\u5224\u65B7\uFF08\u504F\u591A/\u504F\u7A7A/\u4E2D\u6027 + \u4E00\u53E5\u7406\u7531\uFF09';
  const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', max_tokens: 500, messages: [
      { role: 'system', content: '\u4F60\u662F\u89AA\u5207\u7684\u80A1\u7968\u8001\u5E2B\uFF0C\u7528\u53E3\u8A9E\u7E41\u9AD4\u4E2D\u6587\u89E3\u8AAA\uFF0C\u8B93\u521D\u5B78\u8005\u4E5F\u80FD\u61C2\u3002' },
      { role: 'user', content: prompt }
    ]},
    { headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' }, timeout: 25000 }
  );
  return r.data.choices[0].message.content;
}

async function analyzeStock(code) {
  const clean = code.toUpperCase();
  let yahooSymbol, market, stockName = '';
  if (/^\d{4,6}[A-Z]{0,2}$/.test(clean)) {
    yahooSymbol = clean + '.TW'; market = '\u53F0\u80A1'; stockName = TW_NAMES[clean] || '';
  } else if (/^[A-Z]{1,5}$/.test(clean)) {
    yahooSymbol = clean; market = '\u7F8E\u80A1';
  } else return null;

  const data = await getYahooData(yahooSymbol);
  if (!data) return null;

  const closes = data.closes;
  const ma5arr = calcMA(closes, 5);
  const ma20arr = calcMA(closes, 20);
  const ma60arr = calcMA(closes, 60);
  const ma5 = ma5arr[ma5arr.length - 1];
  const ma20 = ma20arr[ma20arr.length - 1];
  const ma60 = ma60arr[ma60arr.length - 1];
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const boll = calcBollinger(closes, 20);
  const volAvg5 = data.volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const volRatio = (data.volume / volAvg5).toFixed(1);
  const arrow = data.change >= 0 ? '\u25B2' : '\u25BC';
  const sign = data.change >= 0 ? '+' : '';
  const title = clean + (stockName ? ' ' + stockName : '');

  let techData = '\u80A1\u7968\uFF1A' + title + '\uFF08' + market + '\uFF09\n';
  techData += '\u73FE\u50F9\uFF1A' + data.price + ' ' + data.currency + '\n';
  techData += '\u6F32\u8DCC\uFF1A' + arrow + Math.abs(data.change).toFixed(2) + ' (' + sign + data.changePct + '%)\n';
  techData += '\u4ECA\u65E5\u9AD8\u4F4E\uFF1A' + data.dayHigh + ' / ' + data.dayLow + '\n';
  techData += '52\u9031\uFF1A' + data.low52 + ' ~ ' + data.high52 + '\n';
  if (ma5) techData += 'MA5\uFF1A' + ma5 + '\n';
  if (ma20) techData += 'MA20\uFF1A' + ma20 + '\n';
  if (ma60) techData += 'MA60\uFF1A' + ma60 + '\n';
  if (rsi) techData += 'RSI\uFF1A' + rsi + '\uFF08' + (rsi > 70 ? '\u8D85\u8CB7' : rsi < 30 ? '\u8D85\u8CE3' : '\u6B63\u5E38') + '\uFF09\n';
  if (macd) techData += 'MACD\uFF1A' + macd + '\uFF08' + (macd > 0 ? '\u6B63\u503C\u504F\u591A' : '\u8CA0\u503C\u504F\u7A7A') + '\uFF09\n';
  if (boll) {
    const pos = data.price > boll.upper ? '\u4E0A\u8ECC\u4EE5\u4E0A\u904E\u71B1' : data.price > boll.middle ? '\u4E2D\u4E0A\u8ECC\u504F\u5F37' : data.price > boll.lower ? '\u4E2D\u4E0B\u8ECC\u504F\u5F31' : '\u4E0B\u8ECC\u4EE5\u4E0B\u8D85\u8CE3';
    techData += '\u5E03\u6797\uFF1A\u4E0A' + boll.upper + ' \u4E2D' + boll.middle + ' \u4E0B' + boll.lower + '\uFF08' + pos + '\uFF09\n';
  }
  techData += '\u91CF\u6BD4\uFF1A' + volRatio + 'x\uFF08' + (volRatio > 1.5 ? '\u7206\u91CF' : volRatio < 0.5 ? '\u7E2E\u91CF' : '\u6B63\u5E38') + '\uFF09\n';

  const isTW = /^\d/.test(clean);
  const [analysis, chartUrl, chip] = await Promise.all([
    askGroq(techData),
    getChartUrl(title, data.labels, closes, ma5arr, ma20arr, ma60arr),
    isTW ? getTWChipData(clean) : Promise.resolve(null)
  ]);

  const srText = calcSupportResistance(data.price, ma5, ma20, ma60, boll, data.high52, data.low52);
  const chipText = formatChip(chip);

  const textMsg = '\u{1F4C8} ' + title + ' \u5206\u6790\u5831\u544A\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\u73FE\u50F9\uFF1A' + data.price + ' ' + data.currency + '\t' + arrow + data.changePct + '%\n\u4ECA\u65E5\uFF1A' + data.dayHigh + ' / ' + data.dayLow + '\n\u6210\u4EA4\u91CF\uFF1A' + Number(data.volume).toLocaleString() + '\uFF08\u91CF\u6BD4 ' + volRatio + 'x\uFF09\n52\u9031\uFF1A' + data.low52 + ' ~ ' + data.high52 + '\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' + analysis + '\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' + srText + (chipText ? '\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' + chipText : '');

  return { textMsg, chartUrl };
}

function scheduleMorningReport() {
  function getNextTime() {
    const now = new Date();
    const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const next = new Date(tw);
    next.setHours(8, 30, 0, 0);
    if (tw >= next) next.setDate(next.getDate() + 1);
    return next - tw;
  }
  async function sendMorningReport() {
    console.log('Morning report start');
    const users = await getAllUsers();
    for (const uid of users) {
      const stocks = await getWatchlist(uid);
      if (stocks.length === 0) continue;
      await pushText(uid, '\u{1F305} \u65E9\u5B89\uFF01\u60A8\u7684\u81EA\u9078\u80A1\u65E9\u5831\u4F86\u4E86\uFF5E\n\u5206\u6790\u4E2D\uFF0C\u8ACB\u7A0D\u5019...');
      for (const code of stocks) {
        try {
          const result = await analyzeStock(code);
          if (!result) continue;
          await pushText(uid, result.textMsg);
          if (result.chartUrl) await push(uid, [{ type: 'image', originalContentUrl: result.chartUrl, previewImageUrl: result.chartUrl }]);
          await new Promise(r => setTimeout(r, 1000));
        } catch (e) { console.log('morning error:', code, e.message); }
      }
      await pushText(uid, '\u2705 \u65E9\u5831\u5B8C\u6210\uFF01\u7948\u60A8\u4ECA\u5929\u4EA4\u6613\u9806\u5229 \u{1F4CA}');
    }
    setTimeout(sendMorningReport, getNextTime());
  }
  setTimeout(sendMorningReport, getNextTime());
  console.log('Morning report scheduled');
}

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  const events = req.body && req.body.events ? req.body.events : [];
  for (const e of events) {
    if (e.type !== 'message' || e.message.type !== 'text') continue;
    const uid = e.source.userId;
    const txt = e.message.text.trim();
    console.log('msg:', txt);

    if (['說明','help','?','？'].includes(txt.toLowerCase())) {
      await pushText(uid, '\u{1F916} \u80A1\u7968AI\u6A5F\u5668\u4EBA \u4F7F\u7528\u8AAA\u660E\n\n\u{1F4CA} \u67E5\u8A62\u80A1\u7968\uFF1A\u76F4\u63A5\u8F38\u5165\u4EE3\u78BC\n\u53F0\u80A1\uFF1A2330\u300100940\n\u7F8E\u80A1\uFF1AAAPL\u3001NVDA\n\n\u2B50 \u81EA\u9078\u80A1\uFF1A\n+2330 \u52A0\u5165\n-2330 \u79FB\u9664\n\u6211\u7684\u80A1\u7968 \u67E5\u770B\u6E05\u55AE\n\u65E9\u5831 \u7ACB\u5373\u5206\u6790\u5168\u90E8\n\n\u6BCF\u5929 08:30 \u81EA\u52D5\u63A8\u64AD\u65E9\u5831');
      continue;
    }

    if (txt.startsWith('+')) {
      const code = txt.slice(1).trim().toUpperCase();
      if (/^\d{4,6}[A-Z]{0,2}$/.test(code) || /^[A-Z]{1,5}$/.test(code)) {
        const r = await addToWatchlist(uid, code);
        const name = TW_NAMES[code] ? code + ' ' + TW_NAMES[code] : code;
        if (r === 'ok') await pushText(uid, '\u2705 \u5DF2\u52A0\u5165\u81EA\u9078\u80A1\uFF1A' + name);
        else if (r === 'exists') await pushText(uid, '\u26A0\uFE0F ' + name + ' \u5DF2\u5728\u6E05\u55AE\u4E2D');
        else if (r === 'full') await pushText(uid, '\u26A0\uFE0F \u5DF2\u9054\u4E0A\u965010\u652F\uFF0C\u8ACB\u5148\u79FB\u9664');
        else await pushText(uid, '\u274C \u52A0\u5165\u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66');
      } else { await pushText(uid, '\u26A0\uFE0F \u4EE3\u78BC\u683C\u5F0F\u4E0D\u6B63\u78BA'); }
      continue;
    }

    if (txt.startsWith('-')) {
      const code = txt.slice(1).trim().toUpperCase();
      const r = await removeFromWatchlist(uid, code);
      const name = TW_NAMES[code] ? code + ' ' + TW_NAMES[code] : code;
      if (r === 'ok') await pushText(uid, '\u2705 \u5DF2\u79FB\u9664\uFF1A' + name);
      else await pushText(uid, '\u274C \u79FB\u9664\u5931\u6557');
      continue;
    }

    if (['\u6211\u7684\u80A1\u7968','\u81EA\u9078\u80A1','\u6E05\u55AE'].includes(txt)) {
      const stocks = await getWatchlist(uid);
      if (stocks.length === 0) {
        await pushText(uid, '\u{1F4CB} \u81EA\u9078\u80A1\u6E05\u55AE\u662F\u7A7A\u7684\n\u8F38\u5165 +\u4EE3\u78BC \u65B0\u589E\uFF0C\u4F8B\u5982\uFF1A+2330');
      } else {
        const list = stocks.map((code, i) => (i + 1) + '. ' + code + (TW_NAMES[code] ? ' ' + TW_NAMES[code] : '')).join('\n');
        await pushText(uid, '\u{1F4CB} \u60A8\u7684\u81EA\u9078\u80A1\uFF08' + stocks.length + '/10\uFF09\uFF1A\n\n' + list + '\n\n\u8F38\u5165\u300C\u65E9\u5831\u300D\u7ACB\u5373\u5206\u6790\u5168\u90E8');
      }
      continue;
    }

    if (['\u65E9\u5831','\u5206\u6790\u5168\u90E8','\u6211\u7684\u5206\u6790'].includes(txt)) {
      const stocks = await getWatchlist(uid);
      if (stocks.length === 0) { await pushText(uid, '\u{1F4CB} \u81EA\u9078\u80A1\u662F\u7A7A\u7684\uFF0C\u8F38\u5165 +\u4EE3\u78BC \u65B0\u589E'); continue; }
      await pushText(uid, '\u{1F50D} \u958B\u59CB\u5206\u6790 ' + stocks.length + ' \u652F\u81EA\u9078\u80A1\uFF0C\u8ACB\u7A0D\u5019...');
      for (const code of stocks) {
        try {
          const result = await analyzeStock(code);
          if (!result) { await pushText(uid, '\u26A0\uFE0F ' + code + ' \u8CC7\u6599\u7121\u6CD5\u53D6\u5F97'); continue; }
          await pushText(uid, result.textMsg);
          if (result.chartUrl) await push(uid, [{ type: 'image', originalContentUrl: result.chartUrl, previewImageUrl: result.chartUrl }]);
          await new Promise(r => setTimeout(r, 1500));
        } catch (e) { console.log('error:', code, e.message); }
      }
      await pushText(uid, '\u2705 \u5168\u90E8\u5206\u6790\u5B8C\u6210\uFF01');
      continue;
    }

    const clean = txt.toUpperCase();
    if (/^\d{4,6}[A-Z]{0,2}$/.test(clean) || /^[A-Z]{1,5}$/.test(clean)) {
      const stockName = TW_NAMES[clean] || '';
      await pushText(uid, '\u{1F50D} \u6B63\u5728\u5206\u6790 ' + clean + (stockName ? ' ' + stockName : '') + '\uFF0C\u8ACB\u7A0D\u5019...');
      try {
        const result = await analyzeStock(clean);
        if (!result) { await pushText(uid, '\u26A0\uFE0F \u627E\u4E0D\u5230 ' + clean + ' \u7684\u8CC7\u6599'); continue; }
        await pushText(uid, result.textMsg);
        if (result.chartUrl) await push(uid, [{ type: 'image', originalContentUrl: result.chartUrl, previewImageUrl: result.chartUrl }]);
      } catch (err) {
        console.log('error:', err.message);
        await pushText(uid, '\u274C \u5206\u6790 ' + clean + ' \u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66\u3002');
      }
      continue;
    }

    await pushText(uid, '\u8F38\u5165\u300C\u8AAA\u660E\u300D\u67E5\u770B\u4F7F\u7528\u65B9\u5F0F');
  }
});

app.get('/', (req, res) => res.send('OK'));
app.listen(process.env.PORT || 3000, () => {
  console.log('啟動成功');
  scheduleMorningReport();
});
