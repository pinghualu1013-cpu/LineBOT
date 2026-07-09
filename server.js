const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FMP_API_KEY = process.env.FMP_API_KEY;

function detectMarket(input) {
  const clean = input.trim().toUpperCase();
  if (/^\d{4}$/.test(clean)) return { symbol: clean + '.TW', market: 'TW', display: clean };
  if (/^[A-Z]{1,5}$/.test(clean)) return { symbol: clean, market: 'US', display: clean };
  return null;
}

async function fetchStockQuote(symbol) {
  try {
    const res = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${symbol}?apikey=${FMP_API_KEY}`, { timeout: 8000 });
    return res.data?.[0] || null;
  } catch (e) { return null; }
}

async function fetchStockNews(symbol) {
  try {
    const res = await axios.get(`https://financialmodelingprep.com/api/v3/stock_news?tickers=${symbol}&limit=5&apikey=${FMP_API_KEY}`, { timeout: 8000 });
    return res.data || [];
  } catch (e) { return []; }
}

async function analyzeWithClaude(display, market, quote, newsItems) {
  const quoteText = quote
    ? `價格：${quote.price} ${market === 'TW' ? 'TWD' : 'USD'}｜漲跌：${quote.change > 0 ? '▲' : '▼'}${Math.abs(quote.change).toFixed(2)} (${quote.changesPercentage?.toFixed(2)}%)`
    : '報價無法取得';
  const newsText = newsItems.length > 0
    ? newsItems.slice(0, 3).map((n, i) => `${i+1}. ${n.title}`).join('\n')
    : '目前無新聞';
  const prompt = `你是專業股票分析師，用繁體中文分析以下資料，格式要適合 LINE 閱讀，250字以內。

股票：${display}（${market === 'TW' ? '台股' : '美股'}）
${quoteText}

最新新聞：
${newsText}

請依格式回覆：
📊 ${display} 分析

💹 價格動態
（一句話）

📰 新聞重點
（2-3點）

🧠 多空判斷
（偏多/偏空/中性 + 理由）

⚠️ 風險提示
（一句話）`;

  const res = await axios.post('https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-6', max_tokens: 800, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  return res.data.content?.[0]?.text || '分析失敗，請稍後再試。';
}

async function pushMessage(userId, text) {
  await axios.post('https://api.line.me/v2/bot/message/push',
    { to: userId, messages: [{ type: 'text', text }] },
    { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  const events = req.body?.events || [];
  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue;
    const userId = event.source?.userId;
    const text = event.message.text.trim();
    console.log('收到訊息:', text, 'from:', userId);
    if (!userId) continue;

    if (['說明', 'help', '?', '？'].includes(text.toLowerCase())) {
      await pushMessage(userId, '🤖 股票AI機器人\n\n台股：輸入4位數字（如 2330）\n美股：輸入英文代碼（如 AAPL）');
      continue;
    }

    const stock = detectMarket(text);
    if (!stock) {
      await pushMessage(userId, `⚠️ 無法識別「${text}」\n請輸入台股4位數字或美股英文代碼`);
      continue;
    }

    try {
      await pushMessage(userId, `🔍 正在分析 ${stock.display}，請稍候...`);
      const [quote, news] = await Promise.all([fetchStockQuote(stock.symbol), fetchStockNews(stock.symbol)]);
      const analysis = await analyzeWithClaude(stock.display, stock.market, quote, news);
      await pushMessage(userId, analysis);
    } catch (err) {
      console.error('錯誤:', err.message);
      await pushMessage(userId, `❌ 分析 ${stock.display} 失敗，請稍後再試。`);
    }
  }
});

app.get('/', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ 啟動成功 Port:${PORT}`));
