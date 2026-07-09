const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;
const FMP_KEY = process.env.FMP_API_KEY;

// ==============================
// LINE Push
// ==============================
async function push(userId, text) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/push',
      { to: userId, messages: [{ type: 'text', text }] },
      { headers: { Authorization: 'Bearer ' + LINE_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.log('push error:', e.response ? JSON.stringify(e.response.data) : e.message);
  }
}

// ==============================
// 台股：Yahoo Finance
// ==============================
async function getTWQuote(code) {
  try {
    const symbol = code + '.TW';
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=1d';
    const r = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const meta = r.data.chart.result[0].meta;
    return {
      price: meta.regularMarketPrice,
      prevClose: meta.chartPreviousClose,
      change: meta.regularMarketPrice - meta.chartPreviousClose,
      changePct: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100).toFixed(2),
      volume: meta.regularMarketVolume,
      high52: meta.fiftyTwoWeekHigh,
      low52: meta.fiftyTwoWeekLow,
      currency: 'TWD'
    };
  } catch (e) {
    console.log('TW quote error:', e.message);
    return null;
  }
}

async function getTWNews(code) {
  try {
    const symbol = code + '.TW';
    const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + symbol + '&newsCount=3&enableFuzzyQuery=false';
    const r = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const news = r.data.news || [];
    return news.slice(0, 3).map(n => ({ title: n.title, publisher: n.publisher }));
  } catch (e) {
    console.log('TW news error:', e.message);
    return [];
  }
}

// ==============================
// 美股：FMP
// ==============================
async function getUSQuote(symbol) {
  try {
    const r = await axios.get('https://financialmodelingprep.com/api/v3/quote/' + symbol + '?apikey=' + FMP_KEY, { timeout: 8000 });
    if (!r.data || !r.data[0]) return null;
    const q = r.data[0];
    return {
      price: q.price,
      prevClose: q.previousClose,
      change: q.change,
      changePct: q.changesPercentage ? q.changesPercentage.toFixed(2) : '0',
      volume: q.volume,
      high52: q.yearHigh,
      low52: q.yearLow,
      marketCap: q.marketCap,
      currency: 'USD'
    };
  } catch (e) {
    console.log('US quote error:', e.message);
    return null;
  }
}

async function getUSNews(symbol) {
  try {
    const r = await axios.get('https://financialmodelingprep.com/api/v3/stock_news?tickers=' + symbol + '&limit=3&apikey=' + FMP_KEY, { timeout: 8000 });
    return (r.data || []).slice(0, 3).map(n => ({ title: n.title, publisher: n.site }));
  } catch (e) {
    console.log('US news error:', e.message);
    return [];
  }
}

// ==============================
// 格式化報價
// ==============================
function formatQuote(display, market, quote, news) {
  let info = '股票：' + display + '（' + market + '）\n';

  if (quote) {
    const arrow = quote.change >= 0 ? '▲' : '▼';
    info += '現價：' + quote.price + ' ' + quote.currency + '\n';
    info += '漲跌：' + arrow + Math.abs(quote.change).toFixed(2) + ' (' + (quote.change >= 0 ? '+' : '') + quote.changePct + '%)\n';
    if (quote.volume) info += '成交量：' + Number(quote.volume).toLocaleString() + '\n';
    if (quote.high52) info += '52週高：' + quote.high52 + ' / 低：' + quote.low52 + '\n';
    if (quote.marketCap) info += '市值：$' + (quote.marketCap / 1e9).toFixed(1) + 'B\n';
  } else {
    info += '（報價資料暫時無法取得）\n';
  }

  if (news.length > 0) {
    info += '\n最新消息：\n';
    news.forEach((n, i) => {
      info += (i + 1) + '. ' + n.title + '\n';
    });
  }

  return info;
}

// ==============================
// Groq AI 分析
// ==============================
async function askGroq(info) {
  const prompt = '請分析以下股票資料，用繁體中文，200字內，適合LINE閱讀，依格式回覆：\n\n' +
    '📊 摘要（一句話）\n💹 價格動態\n📰 新聞重點（2-3點）\n🧠 多空判斷（明確說偏多/偏空/中性）\n⚠️ 風險提示\n\n' + info;

  const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      max_tokens: 600,
      messages: [
        { role: 'system', content: '你是專業股票分析師，只用繁體中文回答。' },
        { role: 'user', content: prompt }
      ]
    },
    { headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' }, timeout: 25000 }
  );
  return r.data.choices[0].message.content;
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
    console.log('msg:', txt);

    const clean = txt.toUpperCase();
    let isTW = false;
    let isUS = false;
    let display = clean;

    if (/^\d{4}$/.test(clean)) {
      isTW = true;
    } else if (/^[A-Z]{1,5}$/.test(clean)) {
      isUS = true;
    } else {
      await push(uid, '請輸入：\n• 台股：4位數字（如 2330、0050）\n• 美股：英文代碼（如 AAPL、NVDA）');
      continue;
    }

    await push(uid, '🔍 正在分析 ' + display + '，請稍候...');

    try {
      let quote = null;
      let news = [];

      if (isTW) {
        [quote, news] = await Promise.all([getTWQuote(clean), getTWNews(clean)]);
      } else {
        [quote, news] = await Promise.all([getUSQuote(clean), getUSNews(clean)]);
      }

      const market = isTW ? '台股' : '美股';
      const info = formatQuote(display, market, quote, news);
      console.log('data:', info);

      const result = await askGroq(info);
      await push(uid, result);

    } catch (err) {
      const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
      console.log('error:', errMsg);
      await push(uid, '❌ 分析 ' + display + ' 失敗，請稍後再試。');
    }
  }
});

app.get('/', function(req, res) { res.send('OK'); });
app.listen(process.env.PORT || 3000, function() { console.log('啟動成功'); });
