const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;

// ==============================
// 台股中文名稱對照表
// ==============================
const TW_NAMES = {
  '0050': '元大台灣50', '0051': '元大中型100', '0052': '富邦科技',
  '0053': '元大電子', '0054': '元大台商50', '0055': '元大MSCI金融',
  '0056': '元大高股息', '00878': '國泰永續高股息', '00879': '國泰台灣5G+',
  '00881': '國泰台灣ESG永續', '00882': '中信中國高股息', '00885': '富邦越南',
  '00891': '中信關鍵半導體', '00892': '富邦台灣半導體', '00893': '國泰智能電動車',
  '00894': '中信小型股', '00896': '中信綠能及電動車', '00900': '富邦特選高股息30',
  '00904': '新光臺灣半導體30', '00905': '華南永昌臺灣ESG',
  '00906': '永豐台灣ESG', '00907': '永豐優息存股',
  '00915': '凱基優選高股息30', '00916': '國泰雙月收益',
  '00919': '群益台灣精選高息', '00920': '富邦台灣核心科技',
  '00921': '兆豐龍頭等權重', '00922': '國泰台灣動能高息',
  '00923': '群益台灣ESG低碳50', '00927': '群益半導體收益',
  '00929': '復華台灣科技優息', '00930': '永豐ESG低碳高息',
  '00932': '兆豐永續高息等權', '00933': '國泰台灣領袖50',
  '00934': '中信成長高股息', '00936': '台新臺灣中小',
  '00937': '群益ESG投等債20+', '00939': '統一台灣高息動能',
  '00940': '元大台灣價值高息', '00941': '中信上櫃ESG 30',
  '00943': '兆豐洲際半導體', '00944': '第一金太空衛星',
  '00945': '國泰台灣低波動精選30',
  '00631L': '元大台灣50正2', '00632R': '元大台灣50反1',
  '00633L': '富邦台灣加權正2', '00634R': '富邦台灣加權反1',
  '00637L': '元大滬深300正2', '00638R': '元大滬深300反1',
  '1101': '台泥', '1102': '亞泥', '1216': '統一', '1301': '台塑',
  '1303': '南亞', '1326': '台化', '1402': '遠東新', '2002': '中鋼',
  '2105': '正新', '2207': '和泰車', '2301': '光寶科', '2303': '聯電',
  '2308': '台達電', '2317': '鴻海', '2324': '仁寶', '2325': '矽品',
  '2327': '國巨', '2330': '台積電', '2337': '旺宏', '2345': '智邦',
  '2347': '聯強', '2356': '英業達', '2357': '華碩', '2376': '技嘉',
  '2377': '微星', '2379': '瑞昱', '2382': '廣達', '2383': '台光電',
  '2385': '群光', '2388': '威盛', '2395': '研華', '2408': '南亞科',
  '2409': '友達', '2412': '中華電', '2414': '精技', '2419': '仲琦',
  '2420': '新日興', '2421': '建準', '2424': '隴華', '2426': '鼎元',
  '2427': '三商電', '2429': '銘異', '2430': '燦坤', '2431': '聯昌',
  '2432': '倚天', '2433': '互盛電', '2434': '統懋', '2436': '偉詮電',
  '2439': '美律', '2441': '超豐', '2442': '新美齊', '2443': '億光',
  '2444': '兆赫', '2449': '京元電子', '2450': '神腦', '2451': '創見',
  '2453': '凌通', '2454': '聯發科', '2455': '全新', '2458': '義隆',
  '2459': '敦吉', '2460': '建通', '2461': '光群雷', '2462': '良得電',
  '2463': '捷順', '2464': '盟立', '2465': '麗臺', '2466': '冠西電',
  '2467': '志聖', '2468': '華經', '2471': '資通', '2472': '立隆電',
  '2474': '可成', '2476': '鉅祥', '2477': '美隆電', '2478': '大毅',
  '2480': '敦陽科', '2481': '強茂', '2482': '連宇', '2483': '百容',
  '2484': '希華', '2485': '兆赫', '2486': '一詮', '2488': '漢平',
  '2489': '瑞軒', '2490': '碩正', '2491': '吉祥全', '2492': '華新科',
  '2493': '揚博', '2495': '普安', '2496': '卓越', '2497': '怡利電',
  '2498': '宏達電', '2499': '東貝', '2501': '國建', '2502': '長谷',
  '2504': '國產', '2506': '太設', '2511': '太子', '2515': '中工',
  '2520': '冠德', '2521': '越野', '2522': '宏璟', '2524': '京城',
  '2527': '宏璟', '2528': '皇普', '2530': '華建', '2534': '宏盛',
  '2535': '達欣工', '2537': '聯上發', '2538': '基泰', '2539': '欣陽',
  '2542': '興富發', '2543': '皇昌', '2545': '皇翔', '2546': '根基',
  '2547': '日勝生', '2548': '華固', '2549': '恩德', '2550': '建國',
  '2601': '益航', '2603': '長榮', '2605': '新興', '2606': '裕民',
  '2607': '榮運', '2608': '嘉里大榮', '2609': '陽明', '2610': '華航',
  '2611': '志信', '2612': '中航', '2613': '中櫃', '2614': '東森',
  '2615': '萬海', '2616': '山隆', '2617': '台航', '2618': '長榮航',
  '2619': '泛亞航運', '2622': '大學光', '2624': '景祥', '2626': '台新',
  '2727': '王品', '2731': '雄獅', '2732': '可樂旅遊', '2733': '五福',
  '2734': '易飛網', '2736': '吉康', '2739': '寒舍', '2740': '天蔥',
  '2744': '成霖', '2745': '王道銀行', '2801': '彰銀', '2809': '京城銀',
  '2812': '台中銀', '2820': '華票', '2823': '中壽', '2824': '台壽保',
  '2828': '聯邦銀', '2830': '彰化銀', '2832': '台產', '2834': '臺企銀',
  '2836': '高雄銀', '2837': '萬泰銀', '2838': '聯邦銀', '2839': '中華開發金',
  '2841': '台開', '2845': '遠東銀', '2847': '大眾銀', '2849': '安泰銀',
  '2850': '新產', '2851': '中再保', '2852': '第一保', '2855': '統一證',
  '2856': '元富證', '2860': '新光金', '2861': '日盛金', '2862': '第一金',
  '2880': '華南金', '2881': '富邦金', '2882': '國泰金', '2883': '開發金',
  '2884': '玉山金', '2885': '元大金', '2886': '兆豐金', '2887': '台新金',
  '2888': '新光金', '2889': '國票金', '2890': '永豐金', '2891': '中信金',
  '2892': '第一金', '2912': '統一超', '3008': '大立光', '3011': '今網',
  '3034': '聯詠', '3035': '智原', '3036': '文曄', '3037': '欣興',
  '3038': '全台晶像', '3041': '揚智', '3042': '晶技', '3044': '健鼎',
  '3045': '台灣大', '3046': '建碁', '3047': '訊舟', '3048': '益登',
  '3049': '和鑫', '3050': '鈺德', '3051': '力特', '3052': '夆典',
  '3054': '立德', '3055': '蔚華科', '3056': '總太', '3057': '喬鼎',
  '3058': '立康', '3059': '華晶科', '3060': '銘異', '3062': '建漢',
  '3063': '大陸工程', '3064': '泰偉', '3065': '大眾電腦', '3066': '鈺群',
  '3067': '全域', '3068': '大霸', '3069': '方彥', '3070': '精元',
  '4904': '遠傳', '4938': '和碩', '4958': '臻鼎-KY', '5871': '中租-KY',
  '5876': '上海商銀', '5880': '合庫金', '6505': '台塑化', '6669': '緯穎',
  '6770': '力積電', '8299': '群聯', '9910': '豐泰'
};

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
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=5d';
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
      dayHigh: meta.regularMarketDayHigh,
      dayLow: meta.regularMarketDayLow,
      currency: meta.currency,
      marketCap: meta.marketCap || null
    };
  } catch (e) {
    if (symbol.endsWith('.TW')) {
      try {
        const sym2 = symbol.replace('.TW', '.TWO');
        const r2 = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/' + sym2 + '?interval=1d&range=5d', {
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
          dayHigh: meta.regularMarketDayHigh,
          dayLow: meta.regularMarketDayLow,
          currency: meta.currency,
          marketCap: meta.marketCap || null,
          board: '上櫃'
        };
      } catch (e2) {}
    }
    return null;
  }
}

async function askGroq(info) {
  const prompt = '請根據以下股票技術面資料，用繁體中文做分析，150字內，適合LINE閱讀，依格式回覆：\n\n' +
    '💹 價格動態（一句話描述今日走勢）\n' +
    '📊 技術面觀察（與52週高低比較位階）\n' +
    '🧠 多空判斷（偏多/偏空/中性 + 理由）\n' +
    '⚠️ 風險提示（一句話）\n\n' + info;

  const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      max_tokens: 400,
      messages: [
        { role: 'system', content: '你是專業股票分析師，只用繁體中文回答，分析精簡有力。' },
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
    const cleanCode = txt.trim();
    let yahooSymbol = null;
    let market = null;
    let display = clean;
    let stockName = '';

    if (/^\d{4,6}[A-Z]{0,2}$/.test(clean)) {
      yahooSymbol = clean + '.TW';
      market = '台股';
      stockName = TW_NAMES[cleanCode] || TW_NAMES[clean] || '';
    } else if (/^[A-Z]{1,5}$/.test(clean)) {
      yahooSymbol = clean;
      market = '美股';
    } else {
      await push(uid, '請輸入：\n• 台股：數字代碼（如 2330、00940、00631L）\n• 美股：英文代碼（如 AAPL、NVDA）');
      continue;
    }

    await push(uid, '🔍 正在分析 ' + display + (stockName ? ' ' + stockName : '') + '，請稍候...');

    try {
      const quote = await getYahooQuote(yahooSymbol);

      if (!quote) {
        await push(uid, '⚠️ 找不到 ' + display + ' 的資料，請確認代碼是否正確。');
        continue;
      }

      const arrow = quote.change >= 0 ? '▲' : '▼';
      const sign = quote.change >= 0 ? '+' : '';

      let info = '股票代碼：' + display;
      if (stockName) info += '（' + stockName + '）';
      info += '\n市場：' + market + (quote.board ? '/' + quote.board : '') + '\n';
      info += '現價：' + quote.price + ' ' + quote.currency + '\n';
      info += '今日漲跌：' + arrow + Math.abs(quote.change).toFixed(2) + ' (' + sign + quote.changePct + '%)\n';
      if (quote.dayHigh) info += '今日高低：' + quote.dayHigh + ' / ' + quote.dayLow + '\n';
      if (quote.volume) info += '成交量：' + Number(quote.volume).toLocaleString() + '\n';
      if (quote.high52) info += '52週高點：' + quote.high52 + '\n52週低點：' + quote.low52 + '\n';
      if (quote.marketCap) info += '市值：' + (quote.marketCap > 1e12 ? (quote.marketCap / 1e12).toFixed(2) + '兆' : (quote.marketCap / 1e8).toFixed(0) + '億') + ' ' + quote.currency + '\n';

      const result = await askGroq(info);

      const title = display + (stockName ? ' ' + stockName : '');
      const finalMsg = '📈 ' + title + ' 分析\n' +
        '─────────────\n' +
        '現價：' + quote.price + ' ' + quote.currency + '　' + arrow + quote.changePct + '%\n' +
        '今日：' + quote.dayHigh + ' / ' + quote.dayLow + '\n' +
        '成交量：' + Number(quote.volume).toLocaleString() + '\n' +
        '52週：' + quote.low52 + ' ~ ' + quote.high52 + '\n' +
        '─────────────\n' + result;

      await push(uid, finalMsg);

    } catch (err) {
      console.log('error:', err.response ? JSON.stringify(err.response.data) : err.message);
      await push(uid, '❌ 分析 ' + display + ' 失敗，請稍後再試。');
    }
  }
});

app.get('/', function(req, res) { res.send('OK'); });
app.listen(process.env.PORT || 3000, function() { console.log('啟動成功'); });
