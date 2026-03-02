import { createClient } from '@supabase/supabase-js';

// These come from environment variables (Vite exposes VITE_* vars)
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('[StratOS] Missing Supabase env vars. Copy .env.example to .env.local and fill in values.');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Edge Function invoker ─────────────────────────────────────────────────────
// Drop-in replacement for base44.functions.invoke()
export async function invokeFunction(name, payload = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const res = await supabase.functions.invoke(name, {
    body: payload,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (res.error) throw new Error(res.error.message || `Function ${name} failed`);
  return res.data;
}

// ── Entity helpers (replaces base44.entities.*) ───────────────────────────────
// Generic CRUD wrappers that match the base44 API shape

export const Instrument = {
  async list(market = null, limit = 5000) {
    let q = supabase.from('instruments').select('*').limit(limit);
    if (market) q = q.eq('market', market);
    const { data, error } = await q.order('company_name');
    if (error) throw error;
    return data || [];
  },
  async filter(filters = {}) {
    let q = supabase.from('instruments').select('*');
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },
};

export const Signal = {
  async list(limit = 200) {
    const { data, error } = await supabase
      .from('signals').select('*').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  },
  async insert(signal) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('signals').insert({ ...signal, user_id: user?.id }).select().single();
    if (error) throw error;
    return data;
  },
};

export const Trade = {
  async list() {
    const { data, error } = await supabase
      .from('trades').select('*').order('date', { ascending: false });
    if (error) throw error;
    return data || [];
  },
  async create(trade) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('trades').insert({ ...trade, user_id: user?.id }).select().single();
    if (error) throw error;
    return data;
  },
  async update(id, changes) {
    const { data, error } = await supabase.from('trades').update(changes).eq('id', id).select().single();
    if (error) throw error;
    return data;
  },
  async delete(id) {
    const { error } = await supabase.from('trades').delete().eq('id', id);
    if (error) throw error;
  },
};

export const Watchlist = {
  async list() {
    const { data, error } = await supabase.from('watchlist').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },
  async add(item) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('watchlist').insert({ ...item, user_id: user?.id }).select().single();
    if (error) throw error;
    return data;
  },
  async remove(id) {
    const { error } = await supabase.from('watchlist').delete().eq('id', id);
    if (error) throw error;
  },
  async update(id, changes) {
    const { data, error } = await supabase.from('watchlist').update(changes).eq('id', id).select().single();
    if (error) throw error;
    return data;
  },
};

export const UserSettings = {
  async get() {
    const { data, error } = await supabase.from('user_settings').select('*').single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },
  async update(changes) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from('user_settings')
      .upsert({ ...changes, user_id: user?.id, updated_at: new Date().toISOString() })
      .select().single();
    if (error) throw error;
    return data;
  },
};

export const Backtest = {
  async list() {
    const { data, error } = await supabase.from('backtests').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },
  async save(result) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from('backtests').insert({ ...result, user_id: user?.id }).select().single();
    if (error) throw error;
    return data;
  },
};

// Convenience export matching old import pattern
export const db = { Instrument, Signal, Trade, Watchlist, UserSettings, Backtest };
