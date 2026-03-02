import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

    const { ticker, marketData: d } = await req.json();
    if (!ticker || !d) return Response.json({ error: 'Missing ticker or marketData' }, { status: 400, headers: corsHeaders });

    const price     = d.price?.toFixed(2) ?? 'N/A';
    const ema20     = d.ema20?.toFixed(2) ?? 'N/A';
    const ema50     = d.ema50?.toFixed(2) ?? 'N/A';
    const sma200    = d.sma200?.toFixed(2) ?? 'N/A';
    const rsi       = d.rsi?.toFixed(1) ?? 'N/A';
    const atr       = d.atr?.toFixed(2) ?? 'N/A';
    const vol       = d.volatility ? d.volatility.toFixed(1) + '%' : 'N/A';
    const stopLevel = d.atr ? (d.price - 2.5 * d.atr).toFixed(2) : 'N/A';
    const tpLevel   = d.atr ? (d.price + 3.5 * d.atr).toFixed(2) : 'N/A';

    const emaStatus  = d.ema20 && d.ema50 ? (d.ema20 > d.ema50 ? 'EMA20 > EMA50 ✓ BULLISH' : 'EMA20 < EMA50 ✗ BEARISH') : 'N/A';
    const s200Status = d.price && d.sma200 ? (d.price > d.sma200 ? 'Pris ÖVER SMA200 ✓' : 'Pris UNDER SMA200 ✗') : 'N/A';
    const rsiLabel   = d.rsi ? (d.rsi > 70 ? 'Överköpt ⚠' : d.rsi < 30 ? 'Översåld ⚠' : 'Normalt ✓') : 'N/A';

    const prompt = `Du är en professionell aktieanalytiker specialiserad på teknisk analys. Analysera denna signal och ge en detaljerad bedömning på svenska.

AKTIE: ${ticker} (${d.name || ticker})
MARKNAD: ${d.market} | SEGMENT: ${d.seg || d.segment} | SEKTOR: ${d.sector || 'N/A'}
VALUTA: ${d.currency || 'SEK'}

PRISDATA:
- Aktuell kurs: ${price} ${d.currency || 'SEK'}
- Dagsförändring: ${d.change ? d.change.toFixed(2) + '%' : 'N/A'}
- Volatilitet (årsann.): ${vol}

TEKNISKA INDIKATORER:
- EMA20: ${ema20} | EMA50: ${ema50} → ${emaStatus}
- SMA200: ${sma200} → ${s200Status}
- RSI(14): ${rsi} → ${rsiLabel}
- ATR(14): ${atr}

SIGNALNIVÅER (vid köp idag):
- Entré: ${price}
- Stop-loss: ${stopLevel} (-2.5 × ATR)
- Take profit: ${tpLevel} (+3.5 × ATR)
- R/R: 1:1.4

FUNDAMENTA:
- P/E: ${d.pe_ratio ? d.pe_ratio.toFixed(1) : 'N/A'}
- Direktavkastning: ${d.dividend_yield ? (d.dividend_yield * 100).toFixed(2) + '%' : 'N/A'}
- Börsvärde: ${d.market_cap ? (d.market_cap / 1e9).toFixed(1) + 'Mdr SEK' : 'N/A'}

Returnera ENBART valid JSON:
{
  "verdict": "KÖP" | "AVVAKTA" | "UNDVIK",
  "confidence": number (0-100),
  "summary": "string (2-3 meningar med övergripande bedömning)",
  "strengths": ["string", "string", "string"],
  "weaknesses": ["string", "string"],
  "technical_score": number (0-100, baserat på indikatorerna),
  "risk_assessment": "LÅG" | "MEDEL" | "HÖG",
  "suggested_entry": number,
  "suggested_stop": number,
  "suggested_tp": number,
  "position_size_hint": "string (t.ex. 'Full position', 'Halvposition p.g.a. hög volatilitet')",
  "sector_context": "string (en mening om sektorn och hur den påverkar signalen)",
  "key_levels": {
    "support": number,
    "resistance": number
  }
}`;

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const aiData = await response.json();
    const text = aiData.content?.[0]?.text || '{}';

    let analysis = {};
    try {
      const clean = text.replace(/```json\n?|\n?```/g, '').trim();
      analysis = JSON.parse(clean);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) analysis = JSON.parse(match[0]);
    }

    return Response.json({ analysis }, { headers: corsHeaders });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500, headers: corsHeaders });
  }
});
