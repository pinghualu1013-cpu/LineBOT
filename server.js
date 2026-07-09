const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const TW_NAMES = {
  '0050': '元大台灣50', '0056': '元大高股息', '00878': '國泰永續高股息',
  '00881': '國泰台灣ESG永續', '00919': '群益台灣精選高息', '00929': '復華台灣科技優息',
  '00940': '元大台灣價值高息', '00631L': '元大台灣50正2', '00632R': '元大台灣50反1',
  '1101': '台泥', '1216': '統一', '1301': '台塑', '1303': '南亞', '1326': '台化',
  '2002': '中鋼', '2207': '和泰車', '2303': '聯電', '2308': '台達電', '2317': '鴻海',
  '2327': '國巨', '2330': '台積電', '2357': '華碩', '2376': '技嘉', '2377': '微星',
  '2379': '瑞昱', '2382': '廣達', '2395': '研華', '2408': '南亞科', '2409': '友達',
  '2412': '中華電', '2454': '聯發科', '2474': '可成', '2603': '長榮', '2609': '陽明',
  '2610': '華航', '2615': '萬海', '2618': '長榮航', '2881': '富邦金', '2882': '國泰金',
  '2883': '開發金', '2884': '玉山金', '2885': '元大金', '2886': '兆豐金', '2887': '台新金',
  '2890': '永豐金', '2891': '中信金', '2892': '第一金', '2912': '統一超', '3008': '大立光',
  '3034': '聯詠', '3045': '台灣大', '4904': '遠傳', '4938': '和碩', '5871': '中租-KY',
  '5880': '合庫金', '6505': '台塑化', '6669': '緯穎', '6770': '力積電', '8299': '群聯'
};

// ==============================
// Supabase 自選股操作
// ==============================
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
  } catch (e) { console.log('getWatchlist error:', e.message); return []; }
}

async function addToWatchlist(userId, code) {
  try {
    const existing = await getWatchlist(userId);
    if (existing.includes(code)) return 'exists';
    if (existing.length >= 10) return 'full';
    await SB.post('/watchlist', { user_id: userId, stock_code: code });
    return 'ok';
  } catch (e) { console.log('addWatchlist error:', e.message); return 'error'; }
}

async function removeFromWatchlist(userId, code) {
  try {
    await SB.delete('/watchlist?user_id=eq.' + userId + '&stock_code=eq.' + code);
    return 'ok';
  } catch (e) { console.log('removeWatchlist error:', e.message); return 'error'; }
}

async function getAllUsers() {
  try {
    const r = await SB.get('/watchlist?select=user_id&order=user_id');
    const ids = [...new Set(r.data.map(row => row.user_id))];
    return ids;
  } catch (e) { console.log('getAllUsers error:', e.message); return []; }
}

// ==============================
// LINE Push
// ==============================
async function push(userId, messages) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/push',
      { to: userId, messages },
      { headers: { Authorization: 'Bearer ' + LINE_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (e) { console.log('push error:', e.response ? JSON.stringify(e.response.data) : e.message); }
}

async function pushText(userId, text) {
  await push(userId, [{ type: 'text', text }]);
}

// ==============================
// Yahoo Finance 資料
// ==============================
async function getYahooData(symbol) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=3mo';
    const r = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
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

// ==============================
// 技術指標
// ==============================
function calcMA(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1).filter(c => c !== null);
    if (slice.length < period) return null;
    return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(2));
  });
}

function calcRSI(closes, period = 14) {
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

function calcBollinger(closes, period = 20) {
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

// ==============================
// QuickChart 圖表
// ==============================
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
  } catch (e) { console.log('chart error:', e.message); return null; }
}

// ==============================
// Groq AI 分析
// ==============================
async function askGroq(techData) {
  const prompt = `你是股票老師，請用口語化、淺顯易懂的繁體中文解釋以下技術指標，像在跟朋友說話一樣，180字內。

${techData}

請依格式回覆：
💹 今日走勢（一句話）
📊 均線排列（說多頭/空頭/糾結，白話解釋）
🔥 RSI強弱（超買/超賣/正常，給建議）
📉 MACD動能（往上/往下，代表什麼）
🎯 布林位置（在哪個區間，代表什麼）
🧠 綜合判斷（偏多/偏空/中性 + 一句理由）`;

  const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', max_tokens: 500, messages: [
      { role: 'system', content: '你是親切的股票老師，用口語繁體中文解說，讓初學者也能懂。' },
      { role: 'user', content: prompt }
    ]},
    { headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' }, timeout: 25000 }
  );
  return r.data.choices[0].message.content;
}

// ==============================
// 籌碼面：台股三大法人（TWSE）
// ==============================
async function getTWChipData(code) {
  try {
    // 取得最近交易日的三大法人買賣超
    const url = 'https://www.twse.com.tw/rwd/zh/fund/T86?response=json&selectType=ALLBUT0999';
    const r = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!r.data || !r.data.data) return null;

    // 找對應股票代碼
    const row = r.data.data.find(item => item[0] === code);
    if (!row) return null;

    // 欄位：[代碼, 名稱, 外資買, 外資賣, 外資淨, 投信買, 投信賣, 投信淨, 自營買, 自營賣, 自營淨, 三大法人淨]
    const parseNum = s => parseInt((s || '0').replace(/,/g, '')) || 0;
    return {
      foreign: parseNum(row[4]),    // 外資淨買賣超（張）
      invest: parseNum(row[7]),     // 投信淨買賣超
      dealer: parseNum(row[10]),    // 自營商淨買賣超
      total: parseNum(row[11])      // 三大法人合計
    };
  } catch (e) {
    console.log('chip error:', e.message);
    return null;
  }
}

function formatChip(chip) {
  if (!chip) return null;
  const fmt = (n) => {
    const sign = n >= 0 ? '+' : '';
    return sign + n.toLocaleString() + ' 張 ' + (n >= 0 ? '▲' : '▼');
  };
  return '🏦 籌碼面（三大法人）
' +
    '外資　：' + fmt(chip.foreign) + '
' +
    '投信　：' + fmt(chip.invest) + '
' +
    '自營商：' + fmt(chip.dealer) + '
' +
    '合計　：' + fmt(chip.total);
}

// ==============================
// 支撐壓力位計算
// ==============================
function calcSupportResistance(price, ma5, ma20, ma60, boll, high52, low52) {
  const levels = [];

  // 壓力位（高於現價）
  const resistances = [];
  if (high52 && high52 > price) resistances.push({ price: high52, label: '52週高點' });
  if (boll && boll.upper > price) resistances.push({ price: boll.upper, label: '布林上軌' });
  if (ma5 && ma5 > price) resistances.push({ price: ma5, label: 'MA5' });
  if (ma20 && ma20 > price) resistances.push({ price: ma20, label: 'MA20' });
  if (ma60 && ma60 > price) resistances.push({ price: ma60, label: 'MA60' });

  // 支撐位（低於現價）
  const supports = [];
  if (ma5 && ma5 < price) supports.push({ price: ma5, label: 'MA5' });
  if (ma20 && ma20 < price) supports.push({ price: ma20, label: 'MA20' });
  if (ma60 && ma60 < price) supports.push({ price: ma60, label: 'MA60' });
  if (boll && boll.middle < price) supports.push({ price: boll.middle, label: '布林中軌' });
  if (boll && boll.lower < price) supports.push({ price: boll.lower, label: '布林下軌' });
  if (low52 && low52 < price) supports.push({ price: low52, label: '52週低點' });

  // 排序
  resistances.sort((a, b) => a.price - b.price);
  supports.sort((a, b) => b.price - a.price);

  let result = '🎯 支撐壓力分析
';

  // 顯示最近2個壓力位
  const topR = resistances.slice(0, 2);
  if (topR.length > 0) {
    topR.reverse().forEach(r => {
      result += '🔴 壓力：' + r.price.toFixed(2) + '（' + r.label + '）
';
    });
  }

  result += '▶ 現價：' + price.toFixed(2) + '
';

  // 顯示最近2個支撐位
  const topS = supports.slice(0, 2);
  topS.forEach(s => {
    result += '🟢 支撐：' + s.price.toFixed(2) + '（' + s.label + '）
';
  });

  // 操作建議
  if (topR.length > 0 && topS.length > 0) {
    const nearR = topR[0].price;
    const nearS = topS[0].price;
    const distR = ((nearR - price) / price * 100).toFixed(1);
    const distS = ((price - nearS) / price * 100).toFixed(1);
    result += '
📌 距壓力 +' + distR + '%　距支撐 -' + distS + '%';
  }

  return result;
}

// ==============================
// 分析單支股票（核心函式）
// ==============================
async function analyzeStock(code) {
  const clean = code.toUpperCase();
  let yahooSymbol, market, stockName = '';

  if (/^\d{4,6}[A-Z]{0,2}$/.test(clean)) {
    yahooSymbol = clean + '.TW';
    market = '台股';
    stockName = TW_NAMES[clean] || '';
  } else if (/^[A-Z]{1,5}$/.test(clean)) {
    yahooSymbol = clean;
    market = '美股';
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
  const arrow = data.change >= 0 ? '▲' : '▼';
  const sign = data.change >= 0 ? '+' : '';
  const title = clean + (stockName ? ' ' + stockName : '');

  let techData = '股票：' + title + '（' + market + '）\n';
  techData += '現價：' + data.price + ' ' + data.currency + '\n';
  techData += '漲跌：' + arrow + Math.abs(data.change).toFixed(2) + ' (' + sign + data.changePct + '%)\n';
  techData += '今日高低：' + data.dayHigh + ' / ' + data.dayLow + '\n';
  techData += '52週：' + data.low52 + ' ~ ' + data.high52 + '\n';
  if (ma5) techData += 'MA5：' + ma5 + '\n';
  if (ma20) techData += 'MA20：' + ma20 + '\n';
  if (ma60) techData += 'MA60：' + ma60 + '\n';
  if (rsi) techData += 'RSI：' + rsi + '（' + (rsi > 70 ? '超買' : rsi < 30 ? '超賣' : '正常') + '）\n';
  if (macd) techData += 'MACD：' + macd + '（' + (macd > 0 ? '正值偏多' : '負值偏空') + '）\n';
  if (boll) {
    const pos = data.price > boll.upper ? '上軌以上過熱' : data.price > boll.middle ? '中上軌偏強' : data.price > boll.lower ? '中下軌偏弱' : '下軌以下超賣';
    techData += '布林：上' + boll.upper + ' 中' + boll.middle + ' 下' + boll.lower + '（' + pos + '）\n';
  }
  techData += '量比：' + volRatio + 'x（' + (volRatio > 1.5 ? '爆量' : volRatio < 0.5 ? '縮量' : '正常') + '）\n';

  // 籌碼面（台股限定）
  const isTW = /^\d/.test(code);
  const [analysis, chartUrl, chip] = await Promise.all([
    askGroq(techData),
    getChartUrl(title, data.labels, closes, ma5arr, ma20arr, ma60arr),
    isTW ? getTWChipData(clean) : Promise.resolve(null)
  ]);

  // 支撐壓力
  const srText = calcSupportResistance(data.price, ma5, ma20, ma60, boll, data.high52, data.low52);
  const chipText = formatChip(chip);

  const textMsg = '📈 ' + title + ' 分析報告\n' +
    '─────────────\n' +
    '現價：' + data.price + ' ' + data.currency + '　' + arrow + data.changePct + '%\n' +
    '今日：' + data.dayHigh + ' ／ ' + data.dayLow + '\n' +
    '成交量：' + Number(data.volume).toLocaleString() + '（量比 ' + volRatio + 'x）\n' +
    '52週：' + data.low52 + ' ～ ' + data.high52 + '\n' +
    '─────────────\n' +
    analysis + '\n' +
    '─────────────\n' +
    srText +
    (chipText ? '\n─────────────\n' + chipText : '');

  return { textMsg, chartUrl };
}

// ==============================
// 定時早報（每天 08:30 台灣時間）
// ==============================
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
    console.log('📢 早報推播開始');
    const users = await getAllUsers();
    for (const uid of users) {
      const stocks = await getWatchlist(uid);
      if (stocks.length === 0) continue;

      await pushText(uid, '🌅 早安！您的自選股早報來了～\n分析中，請稍候...');

      for (const code of stocks) {
        try {
          const result = await analyzeStock(code);
          if (!result) continue;
          await pushText(uid, result.textMsg);
          if (result.chartUrl) {
            await push(uid, [{ type: 'image', originalContentUrl: result.chartUrl, previewImageUrl: result.chartUrl }]);
          }
          await new Promise(r => setTimeout(r, 1000));
        } catch (e) { console.log('morning report error:', code, e.message); }
      }

      await pushText(uid, '✅ 早報完成！祝您今天交易順利 📊');
    }
    setTimeout(sendMorningReport, getNextTime());
  }

  setTimeout(sendMorningReport, getNextTime());
  console.log('⏰ 早報排程已設定，每天 08:30 推播');
}

// ==============================
// Webhook
// ==============================
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  const events = req.body && req.body.events ? req.body.events : [];

  for (const e of events) {
    if (e.type !== 'message' || e.message.type !== 'text') continue;
    const uid = e.source.userId;
    const txt = e.message.text.trim();
    console.log('msg:', txt, 'uid:', uid);

    // ── 說明指令 ──
    if (['說明', 'help', '?', '？'].includes(txt.toLowerCase())) {
      await pushText(uid, '🤖 股票AI機器人 使用說明\n\n' +
        '📊 查詢股票：\n直接輸入代碼\n• 台股：2330、00940、00631L\n• 美股：AAPL、NVDA\n\n' +
        '⭐ 自選股：\n• +2330 → 加入自選股\n• -2330 → 移除自選股\n• 我的股票 → 查看清單\n• 早報 → 立即分析全部自選股\n\n' +
        '📌 最多可加入 10 支股票\n每天 08:30 自動推播早報 🌅');
      continue;
    }

    // ── 加入自選股：+2330 ──
    if (txt.startsWith('+')) {
      const code = txt.slice(1).trim().toUpperCase();
      if (/^\d{4,6}[A-Z]{0,2}$/.test(code) || /^[A-Z]{1,5}$/.test(code)) {
        const result = await addToWatchlist(uid, code);
        const name = TW_NAMES[code] ? code + ' ' + TW_NAMES[code] : code;
        if (result === 'ok') await pushText(uid, '✅ 已加入自選股：' + name + '\n輸入「我的股票」查看清單');
        else if (result === 'exists') await pushText(uid, '⚠️ ' + name + ' 已在自選股清單中');
        else if (result === 'full') await pushText(uid, '⚠️ 自選股已達上限（10支），請先移除再新增');
        else await pushText(uid, '❌ 加入失敗，請稍後再試');
      } else {
        await pushText(uid, '⚠️ 代碼格式不正確\n台股輸入數字（如 +2330）\n美股輸入英文（如 +AAPL）');
      }
      continue;
    }

    // ── 移除自選股：-2330 ──
    if (txt.startsWith('-')) {
      const code = txt.slice(1).trim().toUpperCase();
      const result = await removeFromWatchlist(uid, code);
      const name = TW_NAMES[code] ? code + ' ' + TW_NAMES[code] : code;
      if (result === 'ok') await pushText(uid, '✅ 已移除自選股：' + name);
      else await pushText(uid, '❌ 移除失敗，請稍後再試');
      continue;
    }

    // ── 查看自選股清單 ──
    if (['我的股票', '自選股', '清單'].includes(txt)) {
      const stocks = await getWatchlist(uid);
      if (stocks.length === 0) {
        await pushText(uid, '📋 您的自選股清單是空的\n\n輸入 +代碼 來新增\n例如：+2330、+AAPL');
      } else {
        const list = stocks.map((code, i) => {
          const name = TW_NAMES[code] || '';
          return (i + 1) + '. ' + code + (name ? ' ' + name : '');
        }).join('\n');
        await pushText(uid, '📋 您的自選股清單（' + stocks.length + '/10）：\n\n' + list + '\n\n輸入「早報」立即分析全部');
      }
      continue;
    }

    // ── 立即早報 ──
    if (['早報', '分析全部', '我的分析'].includes(txt)) {
      const stocks = await getWatchlist(uid);
      if (stocks.length === 0) {
        await pushText(uid, '📋 自選股清單是空的\n輸入 +代碼 新增，例如：+2330');
        continue;
      }
      await pushText(uid, '🔍 開始分析您的 ' + stocks.length + ' 支自選股，請稍候...');
      for (const code of stocks) {
        try {
          const result = await analyzeStock(code);
          if (!result) { await pushText(uid, '⚠️ ' + code + ' 資料無法取得'); continue; }
          await pushText(uid, result.textMsg);
          if (result.chartUrl) {
            await push(uid, [{ type: 'image', originalContentUrl: result.chartUrl, previewImageUrl: result.chartUrl }]);
          }
          await new Promise(r => setTimeout(r, 1500));
        } catch (e) { console.log('watchlist analyze error:', code, e.message); }
      }
      await pushText(uid, '✅ 全部分析完成！');
      continue;
    }

    // ── 查詢單支股票 ──
    const clean = txt.toUpperCase();
    if (/^\d{4,6}[A-Z]{0,2}$/.test(clean) || /^[A-Z]{1,5}$/.test(clean)) {
      const stockName = TW_NAMES[clean] || '';
      const title = clean + (stockName ? ' ' + stockName : '');
      await pushText(uid, '🔍 正在分析 ' + title + '，請稍候...');
      try {
        const result = await analyzeStock(clean);
        if (!result) { await pushText(uid, '⚠️ 找不到 ' + clean + ' 的資料，請確認代碼是否正確。'); continue; }
        await pushText(uid, result.textMsg);
        if (result.chartUrl) {
          await push(uid, [{ type: 'image', originalContentUrl: result.chartUrl, previewImageUrl: result.chartUrl }]);
        }
      } catch (err) {
        console.log('error:', err.message);
        await pushText(uid, '❌ 分析 ' + clean + ' 失敗，請稍後再試。');
      }
      continue;
    }

    // ── 未識別 ──
    await pushText(uid, '輸入「說明」查看使用方式 😊');
  }
});

app.get('/', function(req, res) { res.send('OK'); });
app.listen(process.env.PORT || 3000, function() {
  console.log('✅ 啟動成功');
  scheduleMorningReport();
});
