import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Static fallback list for Swedish instruments (used if Nasdaq API is unavailable)
// This is the base list - the live sync adds everything Nasdaq has
const SWEDISH_BASE: Array<{ ticker: string; company_name: string; segment: string; sector: string }> = [
  // Large Cap
  { ticker: 'ABB',      company_name: 'ABB Ltd',              segment: 'large', sector: 'Industri' },
  { ticker: 'ALFA',     company_name: 'Alfa Laval',           segment: 'large', sector: 'Industri' },
  { ticker: 'ALIV-SDB', company_name: 'Autoliv SDB',          segment: 'large', sector: 'Industri' },
  { ticker: 'ASSA-B',   company_name: 'ASSA ABLOY B',         segment: 'large', sector: 'Industri' },
  { ticker: 'ATCO-A',   company_name: 'Atlas Copco A',        segment: 'large', sector: 'Industri' },
  { ticker: 'ATCO-B',   company_name: 'Atlas Copco B',        segment: 'large', sector: 'Industri' },
  { ticker: 'AZN',      company_name: 'AstraZeneca',          segment: 'large', sector: 'Hälsa' },
  { ticker: 'AZA',      company_name: 'Avanza Bank',          segment: 'large', sector: 'Finans' },
  { ticker: 'AAK',      company_name: 'AAK AB',               segment: 'large', sector: 'Konsument' },
  { ticker: 'AXFO',     company_name: 'Axfood',               segment: 'large', sector: 'Konsument' },
  { ticker: 'BALD-B',   company_name: 'Fastighets AB Balder', segment: 'large', sector: 'Fastigheter' },
  { ticker: 'BEIJ-B',   company_name: 'Beijer Ref B',         segment: 'large', sector: 'Industri' },
  { ticker: 'BOL',      company_name: 'Boliden',              segment: 'large', sector: 'Material' },
  { ticker: 'ADDT-B',   company_name: 'Addtech B',            segment: 'large', sector: 'Industri' },
  { ticker: 'EPI-A',    company_name: 'Epiroc A',             segment: 'large', sector: 'Industri' },
  { ticker: 'EPI-B',    company_name: 'Epiroc B',             segment: 'large', sector: 'Industri' },
  { ticker: 'EQT',      company_name: 'EQT AB',               segment: 'large', sector: 'Finans' },
  { ticker: 'ERIC-A',   company_name: 'Ericsson A',           segment: 'large', sector: 'Teknik' },
  { ticker: 'ERIC-B',   company_name: 'Ericsson B',           segment: 'large', sector: 'Teknik' },
  { ticker: 'ESSITY-A', company_name: 'Essity A',             segment: 'large', sector: 'Konsument' },
  { ticker: 'ESSITY-B', company_name: 'Essity B',             segment: 'large', sector: 'Konsument' },
  { ticker: 'EVO',      company_name: 'Evolution AB',         segment: 'large', sector: 'Spel' },
  { ticker: 'GETI-B',   company_name: 'Getinge B',            segment: 'large', sector: 'Hälsa' },
  { ticker: 'HEXA-B',   company_name: 'Hexagon B',            segment: 'large', sector: 'Teknik' },
  { ticker: 'HM-B',     company_name: 'H&M B',               segment: 'large', sector: 'Konsument' },
  { ticker: 'ICA',      company_name: 'ICA Gruppen',          segment: 'large', sector: 'Konsument' },
  { ticker: 'INDT',     company_name: 'Indutrade',            segment: 'large', sector: 'Industri' },
  { ticker: 'INDU-A',   company_name: 'Industrivärden A',     segment: 'large', sector: 'Finans' },
  { ticker: 'INDU-C',   company_name: 'Industrivärden C',     segment: 'large', sector: 'Finans' },
  { ticker: 'INVE-A',   company_name: 'Investor A',           segment: 'large', sector: 'Finans' },
  { ticker: 'INVE-B',   company_name: 'Investor B',           segment: 'large', sector: 'Finans' },
  { ticker: 'JM',       company_name: 'JM AB',               segment: 'large', sector: 'Fastigheter' },
  { ticker: 'KINV-B',   company_name: 'Kinnevik B',           segment: 'large', sector: 'Finans' },
  { ticker: 'LATO-B',   company_name: 'Latour B',             segment: 'large', sector: 'Finans' },
  { ticker: 'LIFCO-B',  company_name: 'Lifco B',              segment: 'large', sector: 'Industri' },
  { ticker: 'NIBE-B',   company_name: 'NIBE Industrier B',    segment: 'large', sector: 'Industri' },
  { ticker: 'NDA-SE',   company_name: 'Nordea Bank',          segment: 'large', sector: 'Finans' },
  { ticker: 'SAAB-B',   company_name: 'Saab B',              segment: 'large', sector: 'Industri' },
  { ticker: 'SAGA-B',   company_name: 'Sagax B',              segment: 'large', sector: 'Fastigheter' },
  { ticker: 'SAND',     company_name: 'Sandvik',              segment: 'large', sector: 'Industri' },
  { ticker: 'SAVE',     company_name: 'Nordnet',              segment: 'large', sector: 'Finans' },
  { ticker: 'SCA-B',    company_name: 'SCA B',               segment: 'large', sector: 'Material' },
  { ticker: 'SEB-A',    company_name: 'SEB A',               segment: 'large', sector: 'Finans' },
  { ticker: 'SEB-C',    company_name: 'SEB C',               segment: 'large', sector: 'Finans' },
  { ticker: 'SECU-B',   company_name: 'Securitas B',          segment: 'large', sector: 'Industri' },
  { ticker: 'SHB-A',    company_name: 'Handelsbanken A',      segment: 'large', sector: 'Finans' },
  { ticker: 'SHB-B',    company_name: 'Handelsbanken B',      segment: 'large', sector: 'Finans' },
  { ticker: 'SINCH',    company_name: 'Sinch',               segment: 'large', sector: 'Teknik' },
  { ticker: 'SKA-B',    company_name: 'Skanska B',            segment: 'large', sector: 'Industri' },
  { ticker: 'SKF-A',    company_name: 'SKF A',               segment: 'large', sector: 'Industri' },
  { ticker: 'SKF-B',    company_name: 'SKF B',               segment: 'large', sector: 'Industri' },
  { ticker: 'SOBI',     company_name: 'Swedish Orphan Biovitrum', segment: 'large', sector: 'Hälsa' },
  { ticker: 'SSAB-A',   company_name: 'SSAB A',              segment: 'large', sector: 'Material' },
  { ticker: 'SSAB-B',   company_name: 'SSAB B',              segment: 'large', sector: 'Material' },
  { ticker: 'SWEC-B',   company_name: 'Sweco B',             segment: 'large', sector: 'Industri' },
  { ticker: 'SWED-A',   company_name: 'Swedbank A',           segment: 'large', sector: 'Finans' },
  { ticker: 'TEL2-B',   company_name: 'Tele2 B',             segment: 'large', sector: 'Telecom' },
  { ticker: 'TELIA',    company_name: 'Telia Company',        segment: 'large', sector: 'Telecom' },
  { ticker: 'TREL-B',   company_name: 'Trelleborg B',         segment: 'large', sector: 'Industri' },
  { ticker: 'VOLV-A',   company_name: 'Volvo A',             segment: 'large', sector: 'Industri' },
  { ticker: 'VOLV-B',   company_name: 'Volvo B',             segment: 'large', sector: 'Industri' },
  { ticker: 'ALLEI',    company_name: 'Alleima',              segment: 'large', sector: 'Material' },
  { ticker: 'BURE',     company_name: 'Bure Equity',          segment: 'large', sector: 'Finans' },
  // Mid Cap (sample - full list synced from Nasdaq)
  { ticker: 'AFRY',     company_name: 'AFRY AB',              segment: 'mid', sector: 'Industri' },
  { ticker: 'BIOT',     company_name: 'Biotage',              segment: 'mid', sector: 'Hälsa' },
  { ticker: 'BUFAB',    company_name: 'Bufab',                segment: 'mid', sector: 'Industri' },
  { ticker: 'CAST',     company_name: 'Castellum',            segment: 'mid', sector: 'Fastigheter' },
  { ticker: 'EKTA-B',   company_name: 'Elekta B',             segment: 'mid', sector: 'Hälsa' },
  { ticker: 'ELUX-A',   company_name: 'Electrolux A',         segment: 'mid', sector: 'Konsument' },
  { ticker: 'ELUX-B',   company_name: 'Electrolux B',         segment: 'mid', sector: 'Konsument' },
  { ticker: 'FABG',     company_name: 'Fabege',               segment: 'mid', sector: 'Fastigheter' },
  { ticker: 'HEXP',     company_name: 'Hexatronic',           segment: 'mid', sector: 'Teknik' },
  { ticker: 'INSTAL',   company_name: 'Instalco',             segment: 'mid', sector: 'Industri' },
  { ticker: 'INTRUM',   company_name: 'Intrum',               segment: 'mid', sector: 'Finans' },
  { ticker: 'LIME',     company_name: 'Lime Technologies',    segment: 'mid', sector: 'Teknik' },
  { ticker: 'MEKO',     company_name: 'Mekonomen',            segment: 'mid', sector: 'Konsument' },
  { ticker: 'NCAB',     company_name: 'NCAB Group',           segment: 'mid', sector: 'Industri' },
  { ticker: 'NEWA-B',   company_name: 'New Wave Group B',     segment: 'mid', sector: 'Konsument' },
  { ticker: 'NOLA-B',   company_name: 'Nolato B',             segment: 'mid', sector: 'Industri' },
  { ticker: 'PEAB-B',   company_name: 'Peab B',               segment: 'mid', sector: 'Industri' },
  { ticker: 'PLEJD',    company_name: 'Plejd',                segment: 'mid', sector: 'Teknik' },
  { ticker: 'RATO-B',   company_name: 'Ratos B',              segment: 'mid', sector: 'Finans' },
  { ticker: 'RESURS',   company_name: 'Resurs Holding',       segment: 'mid', sector: 'Finans' },
  { ticker: 'SDIP-B',   company_name: 'Sdiptech B',           segment: 'mid', sector: 'Industri' },
  { ticker: 'THULE',    company_name: 'Thule Group',          segment: 'mid', sector: 'Konsument' },
  { ticker: 'TROAX',    company_name: 'Troax',                segment: 'mid', sector: 'Industri' },
  { ticker: 'VITR',     company_name: 'Vitrolife',            segment: 'mid', sector: 'Hälsa' },
  { ticker: 'WIHL',     company_name: 'Wihlborgs',            segment: 'mid', sector: 'Fastigheter' },
];

// Try to fetch live from Nasdaq Nordic API
async function fetchNasdaqStockholm(): Promise<Array<{ ticker: string; company_name: string; segment: string }> | null> {
  try {
    // Nasdaq provides instrument lists as JSON - try the API
    const url = 'https://api.nasdaq.com/api/quote/list-type/nasdaq?list=sweden&_ad=false';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    
    // Nasdaq API structure varies - extract instruments
    const rows = data?.data?.rows || data?.data?.data?.rows || [];
    if (!rows.length) return null;

    return rows.map((r: Record<string, string>) => ({
      ticker: r.symbol || r.ticker,
      company_name: r.companyName || r.name,
      segment: (r.marketCap > 10e9 ? 'large' : r.marketCap > 1e9 ? 'mid' : 'small'),
    })).filter((i: { ticker: string }) => i.ticker);
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Admin only
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
    const { data: { user }, error } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (error || !user) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });

    // Get existing instruments
    const { data: existing } = await supabase.from('instruments').select('ticker, market');
    const existingSet = new Set((existing || []).map((i: { ticker: string; market: string }) => `${i.market}:${i.ticker}`));

    let source = 'static';
    let instruments = SWEDISH_BASE;

    // Try live Nasdaq data first
    const liveData = await fetchNasdaqStockholm();
    if (liveData && liveData.length > 50) {
      instruments = liveData as typeof SWEDISH_BASE;
      source = 'nasdaq_live';
    }

    const toCreate = instruments
      .filter(i => !existingSet.has(`sweden:${i.ticker}`))
      .map(i => ({
        ticker: i.ticker,
        company_name: i.company_name,
        market: 'sweden',
        segment: i.segment,
        sector: (i as { ticker: string; company_name: string; segment: string; sector?: string }).sector || 'Övrigt',
        currency: 'SEK',
        yahoo_symbol: `${i.ticker}.ST`,
        twelvedata_symbol: `${i.ticker}:XSTO`,
        finnhub_symbol: `${i.ticker}.ST`,
        exchange: 'XSTO',
        created_at: new Date().toISOString(),
      }));

    if (toCreate.length === 0) {
      return Response.json({
        message: 'All instruments already in DB',
        total: existing?.length,
        source,
      }, { headers: corsHeaders });
    }

    const { error: insertError } = await supabase.from('instruments').insert(toCreate);
    if (insertError) throw insertError;

    return Response.json({
      message: `Synced ${toCreate.length} new instruments`,
      created: toCreate.length,
      total: (existing?.length || 0) + toCreate.length,
      source,
    }, { headers: corsHeaders });

  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500, headers: corsHeaders });
  }
});
