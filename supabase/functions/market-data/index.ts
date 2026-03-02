import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Symbol normalization ──────────────────────────────────────────────────────
// Maps market → correct exchange identifier per API
const EXCHANGE_MAP: Record<string, { twelvedata: string; alphavantage: string; finnhub: string }> = {
  sweden: { twelvedata: 'XSTO', alphavantage: '.ST', finnhub: '.ST' },
  usa:    { twelvedata: '',     alphavantage: '',    finnhub: '' },
  uk:     { twelvedata: 'XLON', alphavantage: '.LON', finnhub: '.L' },
  germany:{ twelvedata: 'XETR', alphavantage: '.DEX', finnhub: '.DE' },
  japan:  { twelvedata: 'XTKS', alphavantage: '.TYO', finnhub: '.T' },
  hongkong:{ twelvedata: 'XHKG', alphavantage: '.HKG', finnhub: '.HK' },
};

function getTwelveSymbol(ticker: string, market: string, overrideSymbol?: string): string {
  if (overrideSymbol) return overrideSymbol;
  const ex = EXCHANGE_MAP[market];
  if (!ex || !ex.twelvedata) return ticker;
  return `${ticker}:${ex.twelvedata}`;
}

function getAlphaSymbol(ticker: string, market: string, overrideSymbol?: string): string {
  if (overrideSymbol) return overrideSymbol;
  const ex = EXCHANGE_MAP[market];
  if (!ex || !ex.alphavantage) return ticker;
  return `${ticker}${ex.alphavantage}`;
}

function getFinnhubSymbol(ticker: string, market: string, overrideSymbol?: string): string {
  if (overrideSymbol) return overrideSymbol;
  const ex = EXCHANGE_MAP[market];
  if (!ex || !ex.finnhub) return ticker;
  return `${ticker}${ex.finnhub}`;
}

function getYahooSymbol(ticker: string, market: string, yahooOverride?: string): string {
  if (yahooOverride) return yahooOverride;
  const suffixes: Record<string, string> = {
    sweden: '.ST', uk: '.L', germany: '.DE', japan: '.T', hongkong: '.HK'
  };
  const suffix = suffixes[market] || '';
  return `${ticker}${suffix}`;
}

// ── API fetchers ──────────────────────────────────────────────────────────────
async function fetchTwelveData(symbol: string, apiKey: string): Promise<{ price: number; change: number; volume: number } | null> {
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status === 'error' || !data.close) return null;
    const price = parseFloat(data.close);
    if (!price || price === 0) return null;
    const change = parseFloat(data.percent_change) || 0;
    const volume = parseInt(data.volume) || 0;
    return { price, change, volume };
  } catch {
    return null;
  }
}

async function fetchTwelveHistory(symbol: string, apiKey: string): Promise<number[] | null> {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=200&apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status === 'error' || !data.values) return null;
    // Returns newest-first, we want oldest-first for indicators
    return data.values.map((v: { close: string }) => parseFloat(v.close)).reverse();
  } catch {
    return null;
  }
}

async function fetchFinnhub(symbol: string, apiKey: string): Promise<{ price: number; change: number } | null> {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.c || data.c === 0) return null;
    const change = data.pc ? ((data.c - data.pc) / data.pc) * 100 : 0;
    return { price: data.c, change };
  } catch {
    return null;
  }
}

async function fetchAlphaVantage(symbol: string, apiKey: string): Promise<{ price: number } | null> {
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.Note || data['Error Message']) return null;
    const quote = data['Global Quote'];
    if (!quote) return null;
    const price = parseFloat(quote['05. price']);
    if (!price || price === 0) return null;
    return { price };
  } catch {
    return null;
  }
}

async function fetchYahoo(symbol: string): Promise<{ price: number; change: number } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const closes = result.indicators?.quote?.[0]?.close || [];
    const price = closes.filter(Boolean).at(-1);
    if (!price) return null;
    const prevClose = result.meta?.chartPreviousClose || closes.filter(Boolean).at(-2);
    const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    return { price, change };
  } catch {
    return null;
  }
}

// ── Technical indicators ──────────────────────────────────────────────────────
function calcEMA(arr: number[], period: number): number {
  if (arr.length === 0) return 0;
  const k = 2 / (period + 1);
  const start = Math.max(0, arr.length - period * 3); // Use enough history
  let ema = arr[start];
  for (let i = start + 1; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcSMA(arr: number[], period: number): number {
  const slice = arr.slice(-Math.min(period, arr.length));
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcRSI(closes: number[], period = 14): number {
  const slice = closes.slice(-Math.min(period * 2 + 1, closes.length));
  if (slice.length < 2) return 50;
  const changes = slice.slice(1).map((v, i) => v - slice[i]);
  const gains = changes.map(c => Math.max(c, 0));
  const losses = changes.map(c => Math.max(-c, 0));
  const avgGain = gains.reduce((a, b) => a + b) / gains.length;
  const avgLoss = losses.reduce((a, b) => a + b) / losses.length;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcATR(closes: number[], period = 14): number {
  const n = Math.min(period, closes.length - 1);
  if (n < 1) return closes[closes.length - 1] * 0.02;
  let atr = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    atr += Math.abs(closes[i] - closes[i - 1]);
  }
  return atr / n;
}

function calcVolatility(closes: number[]): number {
  if (closes.length < 10) return 0;
  const returns = closes.slice(-20).slice(1).map((v, i) => Math.log(v / closes.slice(-20)[i]));
  const mean = returns.reduce((a, b) => a + b) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance * 252) * 100; // Annualized volatility %
}

function computeIndicators(closes: number[]) {
  if (closes.length < 5) {
    const p = closes[closes.length - 1] || 100;
    return { ema20: p, ema50: p, sma200: p, rsi: 50, atr: p * 0.02, avgVol: 100000, e20gE50: true, closeGtS200: true, volatility: 20 };
  }
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, Math.min(50, closes.length));
  const sma200 = calcSMA(closes, 200);
  const rsi = calcRSI(closes);
  const atr = calcATR(closes);
  const volatility = calcVolatility(closes);
  return {
    ema20, ema50, sma200, rsi, atr, volatility,
    avgVol: 500000, // Will be overridden if we have volume data
    e20gE50: ema20 > ema50,
    closeGtS200: closes[closes.length - 1] > sma200,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Auth check
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authError || !user) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });

    const twelveKey  = Deno.env.get('TWELVE_DATA_API_KEY') ?? '';
    const finnhubKey = Deno.env.get('FINNHUB_API_KEY') ?? '';
    const alphaKey   = Deno.env.get('ALPHA_VANTAGE_API_KEY') ?? '';

    const body = await req.json();
    let { tickers } = body; // [{ ticker, market, segment, name, sector, yahooSymbol, twelveSymbol }]

    // If no tickers provided, load from DB
    if (!tickers) {
      const { data: instruments } = await supabase
        .from('instruments')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5000);
      tickers = (instruments || []).map((i: Record<string, string>) => ({
        ticker: i.ticker,
        market: i.market,
        segment: i.segment,
        name: i.company_name,
        sector: i.sector,
        yahooSymbol: i.yahoo_symbol,
        twelveSymbol: i.twelvedata_symbol,
        finnhubSymbol: i.finnhub_symbol,
      }));
    }

    if (!tickers?.length) {
      return Response.json({ error: 'No tickers' }, { status: 400, headers: corsHeaders });
    }

    // Load cached prices from DB for fallback
    const tickers_list = tickers.map((t: { ticker: string; market: string }) => t.ticker);
    const { data: cachedPrices } = await supabase
      .from('instruments')
      .select('ticker, market, last_price, last_price_source, pe_ratio, dividend_yield, market_cap')
      .in('ticker', tickers_list);
    const cacheMap: Record<string, Record<string, unknown>> = {};
    for (const c of (cachedPrices || [])) {
      cacheMap[`${c.market}:${c.ticker}`] = c;
    }

    const results: unknown[] = [];
    const BATCH = 5; // Parallel requests per batch

    for (let i = 0; i < tickers.length; i += BATCH) {
      const batch = tickers.slice(i, i + BATCH);

      const settled = await Promise.allSettled(batch.map(async (item: {
        ticker: string; market: string; segment: string; name: string;
        sector: string; yahooSymbol?: string; twelveSymbol?: string; finnhubSymbol?: string;
      }) => {
        const { ticker, market, segment, name, sector } = item;
        const cacheKey = `${market}:${ticker}`;
        const cached = cacheMap[cacheKey] || {};

        let price: number | null = null;
        let change = 0;
        let source = '';
        let closes: number[] | null = null;

        // ── 1. Twelve Data (primary – best Swedish coverage) ──
        if (twelveKey) {
          const sym = getTwelveSymbol(ticker, market, item.twelveSymbol);
          const result = await fetchTwelveData(sym, twelveKey);
          if (result) {
            price = result.price;
            change = result.change;
            source = 'twelve';
            // Try to get history for indicators
            closes = await fetchTwelveHistory(sym, twelveKey);
          }
        }

        // ── 2. Finnhub (fallback) ──
        if (!price && finnhubKey) {
          const sym = getFinnhubSymbol(ticker, market, item.finnhubSymbol);
          const result = await fetchFinnhub(sym, finnhubKey);
          if (result) { price = result.price; change = result.change; source = 'finnhub'; }
        }

        // ── 3. Alpha Vantage (rarely useful for .ST but good for others) ──
        if (!price && alphaKey) {
          const sym = getAlphaSymbol(ticker, market);
          const result = await fetchAlphaVantage(sym, alphaKey);
          if (result) { price = result.price; source = 'alpha'; }
        }

        // ── 4. Yahoo Finance (last resort) ──
        if (!price) {
          const sym = getYahooSymbol(ticker, market, item.yahooSymbol);
          const result = await fetchYahoo(sym);
          if (result) { price = result.price; change = result.change; source = 'yahoo'; }
        }

        // ── 5. Cached price from DB ──
        if (!price && cached.last_price) {
          price = cached.last_price as number;
          source = 'cache';
        }

        // ── No price at all → skip, don't return fake data ──
        if (!price) return { ok: false, ticker, market, error: 'All API sources failed' };

        // Compute indicators
        if (!closes) closes = [price]; // Minimal fallback
        const indicators = computeIndicators(closes.length > 1 ? closes : [price * 0.98, price * 0.99, price]);

        // Update cache in DB asynchronously
        supabase.from('instruments')
          .update({ last_price: price, last_price_source: source, last_updated: new Date().toISOString() })
          .eq('ticker', ticker).eq('market', market)
          .then(() => {});

        return {
          ok: true,
          ticker, t: ticker,
          name, n: name,
          market, segment: segment, seg: segment,
          sector, s: sector,
          price, change,
          source,
          currency: market === 'usa' ? 'USD' : market === 'uk' ? 'GBP' : market === 'germany' ? 'EUR' : market === 'japan' ? 'JPY' : market === 'hongkong' ? 'HKD' : 'SEK',
          ...indicators,
          pe_ratio: cached.pe_ratio,
          dividend_yield: cached.dividend_yield,
          market_cap: cached.market_cap,
        };
      }));

      for (let j = 0; j < settled.length; j++) {
        if (settled[j].status === 'fulfilled') results.push(settled[j].value);
        else results.push({ ok: false, ticker: batch[j].ticker, error: (settled[j] as PromiseRejectedResult).reason?.message });
      }

      // Rate limit pause between batches
      if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 300));
    }

    return Response.json({ results }, { headers: corsHeaders });
  } catch (error) {
    console.error('market-data error:', error);
    return Response.json({ error: (error as Error).message }, { status: 500, headers: corsHeaders });
  }
});
