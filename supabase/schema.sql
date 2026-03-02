-- StratOS Database Schema
-- Run this in Supabase SQL Editor

-- ── Enable RLS ────────────────────────────────────────────────────────────────
-- All tables use Row Level Security so users only see their own data

-- ── Instruments ───────────────────────────────────────────────────────────────
-- Global instrument registry (shared, not per-user)
CREATE TABLE IF NOT EXISTS instruments (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ticker          text NOT NULL,
  company_name    text NOT NULL,
  market          text NOT NULL,  -- 'sweden', 'usa', 'uk', 'germany', 'japan', 'hongkong'
  segment         text,           -- 'large', 'mid', 'small', 'fn' (First North), 'sme'
  sector          text,
  currency        text DEFAULT 'SEK',
  exchange        text,           -- 'XSTO', 'NYSE', 'XLON' etc
  
  -- API symbols (different per provider)
  yahoo_symbol      text,         -- e.g. 'ERIC-B.ST'
  twelvedata_symbol text,         -- e.g. 'ERIC-B:XSTO'
  finnhub_symbol    text,         -- e.g. 'ERIC-B.ST'
  alphavantage_symbol text,       -- e.g. 'ERIC-B.ST'
  
  -- Cached price data
  last_price        numeric(12,4),
  last_price_source text,
  last_updated      timestamptz,
  
  -- Fundamental data (updated periodically)
  pe_ratio          numeric(8,2),
  dividend_yield    numeric(6,4),
  market_cap        numeric(20,0),
  eps               numeric(10,4),
  
  created_at      timestamptz DEFAULT now(),
  UNIQUE(ticker, market)
);

-- No RLS on instruments - it's a shared reference table
-- (optionally: create a read-only role)

-- ── Signals ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker        text NOT NULL,
  market        text NOT NULL,
  signal_type   text NOT NULL DEFAULT 'KÖP',  -- 'KÖP', 'SÄLJ'
  entry         numeric(12,4),
  stop          numeric(12,4),
  take_profit   numeric(12,4),
  risk_pct      numeric(6,4) DEFAULT 0.005,
  rule          text,
  rsi           numeric(6,2),
  ema20         numeric(12,4),
  ema50         numeric(12,4),
  atr           numeric(10,4),
  reasoning     text,
  status        text DEFAULT 'ACTIVE',  -- 'ACTIVE', 'HIT_TP', 'HIT_STOP', 'EXPIRED', 'CLOSED'
  regime        text DEFAULT 'neutral',
  closed_at     timestamptz,
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "signals_user" ON signals
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── Portfolio (Trades) ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker        text NOT NULL,
  company_name  text,
  market        text NOT NULL DEFAULT 'sweden',
  sector        text,
  currency      text DEFAULT 'SEK',
  type          text NOT NULL,  -- 'BUY', 'SELL'
  shares        numeric(12,4) NOT NULL,
  price         numeric(12,4) NOT NULL,
  commission    numeric(10,4) DEFAULT 0,
  date          date NOT NULL DEFAULT CURRENT_DATE,
  note          text,
  signal_id     uuid REFERENCES signals(id),
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trades_user" ON trades
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── Watchlist ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlist (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker        text NOT NULL,
  company_name  text,
  market        text NOT NULL DEFAULT 'sweden',
  sector        text,
  note          text,
  alert_above   numeric(12,4),   -- Price alert: notify if price goes above
  alert_below   numeric(12,4),   -- Price alert: notify if price goes below
  alert_rsi_above numeric(5,2),  -- RSI alert
  alert_rsi_below numeric(5,2),
  created_at    timestamptz DEFAULT now(),
  UNIQUE(user_id, ticker, market)
);

ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "watchlist_user" ON watchlist
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── User Settings ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  user_id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  active_markets    text[] DEFAULT ARRAY['sweden'],
  strategy          jsonb,         -- Custom strategy rules
  risk_profile      text DEFAULT 'balanced',  -- 'conservative', 'balanced', 'aggressive'
  capital           numeric(14,2), -- Total trading capital for position sizing
  api_keys          jsonb,         -- Encrypted user-provided API keys (future)
  notifications     jsonb DEFAULT '{"email": false, "signals": true}'::jsonb,
  updated_at        timestamptz DEFAULT now()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settings_user" ON user_settings
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── Backtest Results ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backtests (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy_name   text,
  strategy_rules  jsonb,
  tickers         text[],
  start_date      date,
  end_date        date,
  total_return    numeric(8,4),
  sharpe_ratio    numeric(6,4),
  max_drawdown    numeric(6,4),
  win_rate        numeric(6,4),
  total_trades    int,
  results         jsonb,          -- Full detailed results
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE backtests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "backtests_user" ON backtests
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_instruments_ticker ON instruments(ticker);
CREATE INDEX IF NOT EXISTS idx_instruments_market ON instruments(market);
CREATE INDEX IF NOT EXISTS idx_instruments_market_ticker ON instruments(market, ticker);
CREATE INDEX IF NOT EXISTS idx_signals_user ON signals(user_id);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_ticker ON trades(ticker);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id);

-- ── Functions ─────────────────────────────────────────────────────────────────
-- Auto-update user_settings on signup
CREATE OR REPLACE FUNCTION create_user_settings()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_settings (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION create_user_settings();
