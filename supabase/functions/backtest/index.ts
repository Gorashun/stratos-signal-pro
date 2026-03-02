import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function fetchYahooHistory(symbol: string, range = '1y'): Promise<Array<{ date: string; close: number; high: number; low: number; volume: number }> | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const r = json?.chart?.result?.[0];
    if (!r) return null;
    const ts = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    return ts.map((t: number, i: number) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      close: q.close?.[i],
      high: q.high?.[i],
      low: q.low?.[i],
      volume: q.volume?.[i] || 0,
    })).filter((d: { close: number }) => d.close != null);
  } catch { return null; }
}

function calcEMA(arr: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let ema = arr[0];
  for (let i = 0; i < arr.length; i++) {
    if (i < period - 1) { ema = (ema * i + arr[i]) / (i + 1); out.push(ema); continue; }
    if (i === period - 1) { out.push(ema); continue; }
    ema = arr[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function calcSMA(arr: number[], period: number): number[] {
  return arr.map((_, i) => {
    if (i < period - 1) return null as unknown as number;
    return arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b) / period;
  });
}

function calcRSI(closes: number[], period = 14): number[] {
  const out: (number | null)[] = new Array(period).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  out.push(100 - 100 / (1 + ag / (al || 1e-9)));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out.push(100 - 100 / (1 + ag / (al || 1e-9)));
  }
  return out as number[];
}

function calcATR(bars: Array<{ high: number; low: number; close: number }>, period = 14): number[] {
  const out: (number | null)[] = [null];
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    trs.push(tr);
    if (i < period) { out.push(null); continue; }
    if (i === period) { out.push(trs.reduce((a, b) => a + b) / period); continue; }
    out.push(((out[i - 1] as number) * (period - 1) + trs[i - 1]) / period);
  }
  return out as number[];
}

interface StrategyRules {
  entries: Array<{ name: string; all_of: Array<{ indicator: string; value?: boolean; op?: string; min?: number; max?: number }> }>;
  exits: Array<{ type: string; atr_mult: number }>;
}

function simulateTicker(bars: Array<{ date: string; close: number; high: number; low: number }>, rules: StrategyRules) {
  if (bars.length < 60) return [];
  const closes = bars.map(b => b.close);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);
  const e20  = calcEMA(closes, 20);
  const e50  = calcEMA(closes, 50);
  const s200 = calcSMA(closes, 200);
  const rsi  = calcRSI(closes);
  const atr  = calcATR(bars.map((b, i) => ({ high: highs[i], low: lows[i], close: b.close })));

  const trades: Array<{ date: string; type: string; price: number; exit_date?: string; exit_price?: number; pnl?: number; pnl_pct?: number }> = [];
  let inTrade = false, entry = 0, stop = 0, tp = 0;

  for (let i = 210; i < bars.length - 1; i++) {
    const c = closes[i], e20v = e20[i], e50v = e50[i], s200v = s200[i], rv = rsi[i], atrv = atr[i];
    if (!e20v || !e50v || !s200v || !rv || !atrv) continue;

    if (inTrade) {
      if (c <= stop || c >= tp) {
        const pnl = (c - entry) / entry;
        trades[trades.length - 1] = { ...trades[trades.length - 1], exit_date: bars[i].date, exit_price: c, pnl, pnl_pct: pnl * 100 };
        inTrade = false;
      }
    } else {
      // Check entry conditions
      const entrySignal = rules.entries?.some(entry_rule =>
        (entry_rule.all_of || []).every(c => {
          if (c.indicator === 'ema20_gt_ema50') return (e20v > e50v) === c.value;
          if (c.indicator === 'close_gt_sma200') return (closes[i] > s200v) === c.value;
          if (c.indicator === 'rsi14') {
            if (c.op === '>') return rv > (c.value as number);
            if (c.op === '<') return rv < (c.value as number);
            if (c.op === 'between') return rv >= (c.min as number) && rv <= (c.max as number);
          }
          return true;
        })
      );

      if (entrySignal) {
        const stopMult = rules.exits?.[0]?.atr_mult || 2.5;
        const tpMult   = rules.exits?.[1]?.atr_mult || 3.5;
        entry = c;
        stop  = c - stopMult * atrv;
        tp    = c + tpMult * atrv;
        inTrade = true;
        trades.push({ date: bars[i].date, type: 'LONG', price: c });
      }
    }
  }

  return trades.filter(t => t.exit_price !== undefined);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
    const { data: { user }, error } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (error || !user) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });

    const { strategy, tickers, range = '2y' } = await req.json();
    if (!strategy || !tickers?.length) return Response.json({ error: 'strategy and tickers required' }, { status: 400, headers: corsHeaders });

    const allTrades: unknown[] = [];
    let successCount = 0;

    for (const { ticker, market } of tickers) {
      const suffixes: Record<string, string> = { sweden: '.ST', uk: '.L', germany: '.DE', japan: '.T', hongkong: '.HK' };
      const symbol = `${ticker}${suffixes[market] || ''}`;
      const bars = await fetchYahooHistory(symbol, range);
      if (!bars || bars.length < 60) continue;

      const trades = simulateTicker(bars as Array<{ date: string; close: number; high: number; low: number }>, strategy);
      for (const t of trades) allTrades.push({ ...t, ticker, market });
      if (trades.length) successCount++;
    }

    // Compute aggregate stats
    const completedTrades = allTrades.filter((t: unknown) => (t as Record<string, unknown>).pnl !== undefined) as Array<{ pnl: number }>;
    const wins = completedTrades.filter(t => t.pnl > 0);
    const losses = completedTrades.filter(t => t.pnl <= 0);
    const totalReturn = completedTrades.reduce((a, b) => a + b.pnl, 0);
    const winRate = completedTrades.length ? wins.length / completedTrades.length : 0;
    const avgWin = wins.length ? wins.reduce((a, b) => a + b.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b.pnl, 0) / losses.length : 0;
    const profitFactor = avgLoss ? Math.abs(avgWin * wins.length) / Math.abs(avgLoss * losses.length) : 0;

    // Max drawdown
    let peak = 1, maxDrawdown = 0, equity = 1;
    for (const t of completedTrades) {
      equity *= (1 + t.pnl);
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const result = {
      strategy_name: strategy.name,
      tickers_tested: tickers.length,
      tickers_with_trades: successCount,
      total_trades: completedTrades.length,
      wins: wins.length,
      losses: losses.length,
      win_rate: winRate,
      total_return: totalReturn,
      avg_win: avgWin,
      avg_loss: avgLoss,
      profit_factor: profitFactor,
      max_drawdown: maxDrawdown,
      range,
      trades: allTrades.slice(0, 200), // Return first 200 trades for detail view
    };

    // Save to DB
    await supabase.from('backtests').insert({
      user_id: user.id,
      strategy_name: strategy.name,
      strategy_rules: strategy,
      tickers: tickers.map((t: { ticker: string }) => t.ticker),
      total_return: totalReturn,
      max_drawdown: maxDrawdown,
      win_rate: winRate,
      total_trades: completedTrades.length,
      results: result,
    });

    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500, headers: corsHeaders });
  }
});
