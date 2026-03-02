import { useState, useCallback } from 'react';
import { supabase, Instrument, UserSettings, invokeFunction } from '@/api/supabaseClient';
import { detectRegime } from './signalEngine';

const CACHE_KEY = 'stratos-md-v4';
const CACHE_TTL = 15 * 60 * 1000;

export const DEFAULT_ACTIVE_MARKETS = ['sweden'];

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch { return null; }
}

function saveCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

export function useStratOS() {
  const [marketData, setMarketData]     = useState(() => loadCache() || {});
  const [signals, setSignals]           = useState([]);
  const [regime, setRegime]             = useState('neutral');
  const [strategy, setStrategy]         = useState(null);
  const [fetching, setFetching]         = useState(false);
  const [fetchProgress, setFetchProgress] = useState({ done: 0, total: 0, current: '' });
  const [logs, setLogs]                 = useState([]);
  const [activeMarkets, setActiveMarkets] = useState(() => {
    try {
      const saved = localStorage.getItem('stratos-active-markets');
      if (saved) {
        const p = JSON.parse(saved);
        return Array.isArray(p) ? p : DEFAULT_ACTIVE_MARKETS;
      }
    } catch {}
    return DEFAULT_ACTIVE_MARKETS;
  });

  const log = useCallback((level, msg) => {
    setLogs(prev => [{ level, msg, time: new Date().toLocaleTimeString('sv-SE') }, ...prev].slice(0, 400));
  }, []);

  const toggleMarket = useCallback((marketId) => {
    setActiveMarkets(prev => {
      const next = prev.includes(marketId)
        ? prev.filter(m => m !== marketId)
        : [...prev, marketId];
      localStorage.setItem('stratos-active-markets', JSON.stringify(next));
      return next;
    });
  }, []);

  // ── Fetch market data ───────────────────────────────────────────────────────
  const fetchData = useCallback(async (marketsOverride) => {
    const markets = marketsOverride || activeMarkets;

    // Load instruments from DB
    let instruments = [];
    try {
      const dbData = await Instrument.list();
      const activeSet = new Set(markets);
      instruments = dbData
        .filter(i => activeSet.has(i.market))
        .map(i => ({
          ticker: i.ticker,
          market: i.market,
          segment: i.segment,
          name: i.company_name,
          sector: i.sector,
          yahooSymbol: i.yahoo_symbol,
          twelveSymbol: i.twelvedata_symbol,
          finnhubSymbol: i.finnhub_symbol,
        }));
    } catch (e) {
      log('ERR', `DB-hämtning misslyckades: ${e.message}`);
      return;
    }

    if (!instruments.length) {
      log('WARN', 'Inga instrument i DB för valda marknader. Kör "Sync instruments" från inställningar.');
      return;
    }

    setFetching(true);
    setFetchProgress({ done: 0, total: instruments.length, current: '' });
    log('INFO', `Hämtar data för ${instruments.length} aktier från ${markets.join(', ')}…`);

    const BATCH = 20; // Send bigger batches to the edge function
    const newMd = {};

    for (let i = 0; i < instruments.length; i += BATCH) {
      const batch = instruments.slice(i, i + BATCH);
      setFetchProgress({ done: i, total: instruments.length, current: batch[0].ticker });

      try {
        const res = await invokeFunction('market-data', { tickers: batch });
        const results = res?.results || [];

        for (const r of results) {
          if (r.ok) {
            const key = `${r.market}:${r.ticker}`;
            newMd[key] = { ...r, t: r.ticker, n: r.name };
            log('OK', `${r.ticker} ${r.price?.toFixed(2)} (${r.source})`);
          } else {
            log('WARN', `✗ ${r.ticker}: ${r.error}`);
          }
        }

        setMarketData(prev => ({ ...prev, ...newMd }));
      } catch (e) {
        log('ERR', `Batch-fel vid ${batch[0].ticker}: ${e.message}`);
      }

      setFetchProgress({ done: Math.min(i + BATCH, instruments.length), total: instruments.length, current: '' });
    }

    const reg = detectRegime(newMd);
    setRegime(reg);
    saveCache(newMd);

    const ok = Object.values(newMd).filter(d => d.ok !== false).length;
    log('INFO', `Klar: ${ok}/${instruments.length} laddade | Regime: ${reg}`);
    setFetching(false);
    setFetchProgress({ done: 0, total: 0, current: '' });
    return newMd;
  }, [activeMarkets, log]);

  // ── Generate signals via AI ────────────────────────────────────────────────
  const generateSignals = useCallback(async (mdOverride) => {
    const md = mdOverride || marketData;
    const entries = Object.values(md).filter(d => d && d.price);
    if (!entries.length) {
      log('WARN', 'Ingen marknadsdata — hämta data först');
      return [];
    }

    log('INFO', `AI analyserar ${entries.length} instrument…`);
    setFetching(true);
    try {
      const res = await invokeFunction('generate-signals', { marketData: md, regime });
      const sigs = (res?.signals || []).map(s => ({
        ...s,
        tp: s.take_profit,
        riskPct: s.risk_pct,
        reason: s.reject_reason,
        currency: s.currency || 'SEK',
      }));
      setSignals(sigs);
      const approved = sigs.filter(s => s.status === 'APPROVED').length;
      if (res?.analysis) log('INFO', `Analys: ${res.analysis}`);
      log('INFO', `Signaler: ${sigs.length} totalt, ${approved} godkända`);
      return sigs;
    } catch (e) {
      log('ERR', `Signalfel: ${e.message}`);
      return [];
    } finally {
      setFetching(false);
    }
  }, [marketData, regime, log]);

  const runCycle = useCallback(async () => {
    const md = await fetchData();
    if (md) generateSignals(md);
  }, [fetchData, generateSignals]);

  // ── Load/save strategy from DB ─────────────────────────────────────────────
  const loadStrategy = useCallback(async () => {
    try {
      const settings = await UserSettings.get();
      if (settings?.strategy) setStrategy(settings.strategy);
    } catch {}
  }, []);

  const saveStrategy = useCallback(async (strat) => {
    try {
      await UserSettings.update({ strategy: strat });
      setStrategy(strat);
      log('INFO', `Strategi "${strat.name}" sparad`);
    } catch (e) {
      log('ERR', `Kunde inte spara strategi: ${e.message}`);
    }
  }, [log]);

  return {
    marketData, signals, regime, strategy,
    setStrategy, saveStrategy, loadStrategy,
    activeMarkets, toggleMarket,
    fetching, fetchProgress,
    fetchData, generateSignals, runCycle,
    logs, log,
  };
}
