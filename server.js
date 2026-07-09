const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;
const FMP_KEY = process.env.FMP_API_KEY;

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

async function getYahooQuote(symbol) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=1d';
    const r = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const meta = r.data.chart.result[0].meta;
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || meta.previousClose;
    const change = price - prev;
    return {
      price: price, change: change,
      changePct: (change / prev * 100).toFixed(2),
      volume: meta.regularMarketVolume,
      high52: meta.fiftyTwoWeekHigh,
      low52: meta.fiftyTwoWeekLow,
      currency: meta.currency
    };
  } catch (e) {
    if (symbol.endsWith('.TW')) {
      try {
        const sym2 = symbol.replace('.TW', '.TWO');
        const r2 = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/' + sym2 + '?interval=1d&range=1d', {
          timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const meta = r2.data.chart.result[0].meta;
        const price = meta.regularMarketPrice;
        const prev = meta.chartPreviousClose || meta.previousClose;
        const change = price - prev;
        return {
          price: price, change: change,
          changePct: (change / prev * 100).toFixed(2),
          volume: meta.regularMarketVolume,
          high52: meta.fiftyTwoWeekHigh,
          low52: meta.fiftyTwoWeekLow,
          currency: meta.currency, market: '上櫃'
        };
      } catch (e2) {}
    }
    return null;
  }
}

// ==============================
// 台股新聞：Yahoo Finance 個股新聞（英文，AI翻譯）
// ==============================
async function getTWNews(yahooSymbol) {
  try {
    const url = 'https://query2.finance.yahoo.com/v1/finance/search?q=' + yahooSymbol + '&newsCount=5&enableFuzzyQuery=false';
    const r = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const news = r.data.news || [];
    return news.slice(0, 3).map(n => ({ title: n.title, publisher: n.publisher || 'Yahoo' }));
  } catch (e) {
    console.log('TW news error:', e.message);
    return [];
  }
}

// ==============================
// 美股新聞：FMP
// ==============================
async function getUSNews(symbol) {
  try {
    const r = await axios.get('https://financialmodelingprep.com/api/v3/stock_news?tickers=' + symbol + '&limit=3&apikey=' + FMP_KEY, { timeout: 8000 });
    return (r.data || []).slice(0, 3).map(n => ({ title: n.title, publisher: n.site }));
  } catch (e) { return []; }
}

async function askGroq(info) {
  const prompt = '請分析以下股票資料，用繁體中文，200字內，適合LINE閱讀。新聞標題若為英文請翻譯成繁體中文。依格式回覆：\n\n' +
    '📊 摘要（一句話）\n💹 價格動態\n📰 新聞重點（2-3點）\n🧠 多空判斷（偏多/偏空/中性）\n⚠️ 風險提示\n\n' + info;

  const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      max_tokens: 600,
      messages: [
        { role: 'system', content: '你是專業股票分析師，只用繁體中文回答，新聞標題一律翻譯成繁體中文。' },
        { role: 'user', content: prompt }
      ]
    },
    { headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' }, timeout: 25000 }
  );
  return r.data.choices[0].message.content;
}

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  const events = req.body && req.body.events ? req.body.events : [];

  for (const e of events) {
    if (e.type !== 'message' || e.message.type !== 'text') continue;
    const uid = e.source.userId;
    const txt = e.message.text.trim();
    console.log('msg:', txt);

    const clean = txt.toUpperCase();
    let yahooSymbol = null;
    let market = null;
    let display = clean;
    let isUS = false;

    if (/^\d{4,6}[A-Z]{0,2}$/.test(clean)) {
      yahooSymbol = clean + '.TW';
      market = '台股';
    } else if (/^[A-Z]{1,5}$/.test(clean)) {
      yahooSymbol = clean;
      market = '美股';
      isUS = true;
    } else {
      await push(uid, '請輸入：\n• 台股：數字代碼（如 2330、00940、00631L）\n• 美股：英文代碼（如 AAPL、NVDA）');
      continue;
    }

    await push(uid, '🔍 正在分析 ' + display + '，請稍候...');

    try {
      const quote = await getYahooQuote(yahooSymbol);
      const news = isUS ? await getUSNews(clean) : await getTWNews(yahooSymbol);

      let info = '股票：' + display + '（' + market + (quote && quote.market ? '/' + quote.market : '') + '）\n';

      if (quote) {
        const arrow = quote.change >= 0 ? '▲' : '▼';
        const sign = quote.change >= 0 ? '+' : '';
        info += '現價：' + quote.price + ' ' + quote.currency + '\n';
        info += '漲跌：' + arrow + Math.abs(quote.change).toFixed(2) + ' (' + sign + quote.changePct + '%)\n';
        if (quote.volume) info += '成交量：' + Number(quote.volume).toLocaleString() + '\n';
        if (quote.high52) info += '52週高：' + quote.high52 + ' / 低：' + quote.low52 + '\n';
      } else {
        info += '（報價暫時無法取得）\n';
      }

      if (news.length > 0) {
        info += '\n最新消息：\n';
        news.forEach((n, i) => { info += (i + 1) + '. ' + n.title + '\n'; });
      }

      console.log('data:', info);
      const result = await askGroq(info);
      await push(uid, result);

    } catch (err) {
      console.log('error:', err.response ? JSON.stringify(err.response.data) : err.message);
      await push(uid, '❌ 分析 ' + display + ' 失敗，請稍後再試。');
    }
  }
});

app.get('/', function(req, res) { res.send('OK'); });
app.listen(process.env.PORT || 3000, function() { console.log('啟動成功'); });
