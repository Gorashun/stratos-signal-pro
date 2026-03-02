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
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authError || !user) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });

    const { marketData, regime } = await req.json();

    const instruments = Object.values(marketData).filter((d: unknown) => {
      const item = d as Record<string, unknown>;
      return item && item.price && item.rsi;
    });

    if (!instruments.length) {
      return Response.json({ signals: [], analysis: 'Ingen marknadsdata tillgänglig.' }, { headers: corsHeaders });
    }

    // Compact data for LLM - only send what matters
    const summary = instruments.map((d: unknown) => {
      const item = d as Record<string, unknown>;
      return {
        ticker: item.t || item.ticker,
        name: item.n || item.name,
        market: item.market,
        seg: item.seg || item.segment,
        price: typeof item.price === 'number' ? +item.price.toFixed(2) : item.price,
        change: typeof item.change === 'number' ? +item.change.toFixed(2) : 0,
        rsi: typeof item.rsi === 'number' ? +item.rsi.toFixed(1) : item.rsi,
        ema20: typeof item.ema20 === 'number' ? +item.ema20.toFixed(2) : item.ema20,
        ema50: typeof item.ema50 === 'number' ? +item.ema50.toFixed(2) : item.ema50,
        atr: typeof item.atr === 'number' ? +item.atr.toFixed(2) : item.atr,
        avgVol: item.avgVol,
        e20gE50: item.e20gE50,
        closeGtS200: item.closeGtS200,
        currency: item.currency,
        volatility: item.volatility,
      };
    });

    const prompt = `Du är en erfaren kvantitativ marknadsanalytiker med fokus på momentum och trendhandel på svenska och globala aktiemarknader.

Marknadsregim: ${regime.toUpperCase()}

Data för ${summary.length} instrument. Identifiera de bästa handelsmöjligheterna baserat på tekniska indikatorer.

REGLER:
- Generera KÖP-signaler för aktier med tydligt momentum och trendstöd
- I bear-regim: var selektiv, godkänn bara starka uppställningar
- Kräv: RSI > 45, e20gE50=true (EMA20 > EMA50), tillräcklig volatilitet
- Volymkrav: avgVol > 50000 (Sverige), > 500000 (USA)
- Beräkna stop: entry - 2.5 × ATR  
- Beräkna TP: entry + 3.5 × ATR (risk/reward ~1.4)
- Inkludera max 50 signaler (de bästa godkända + de mest intressanta avvisade)

Marknadsdata:
${JSON.stringify(summary)}

Svara ENBART med valid JSON, ingen text utanför JSON:
{
  "signals": [
    {
      "ticker": "string",
      "name": "string", 
      "market": "string",
      "seg": "string",
      "currency": "string",
      "signal_type": "KÖP",
      "entry": number,
      "stop": number,
      "take_profit": number,
      "risk_pct": 0.005,
      "rule": "string",
      "status": "APPROVED" | "REJECTED",
      "reject_reason": "string",
      "rsi": number,
      "ema20": number,
      "ema50": number,
      "atr": number,
      "reasoning": "string (2-3 meningar)"
    }
  ],
  "analysis": "string (3-4 meningar om marknadsläget)"
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
        model: 'claude-opus-4-5',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const aiData = await response.json();
    const text = aiData.content?.[0]?.text || '{}';

    let result = { signals: [], analysis: '' };
    try {
      const clean = text.replace(/```json\n?|\n?```/g, '').trim();
      result = JSON.parse(clean);
    } catch {
      // Try to extract JSON from response
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { result = JSON.parse(match[0]); } catch { /* ignore */ }
      }
    }

    // Persist signals to DB
    if (result.signals?.length) {
      const toInsert = result.signals
        .filter((s: Record<string, unknown>) => s.status === 'APPROVED')
        .map((s: Record<string, unknown>) => ({
          ticker: s.ticker,
          market: s.market,
          signal_type: s.signal_type || 'KÖP',
          entry: s.entry,
          stop: s.stop,
          take_profit: s.take_profit,
          risk_pct: s.risk_pct || 0.005,
          rule: s.rule,
          rsi: s.rsi,
          ema20: s.ema20,
          ema50: s.ema50,
          atr: s.atr,
          reasoning: s.reasoning,
          status: 'ACTIVE',
          regime: regime,
          user_id: user.id,
          created_at: new Date().toISOString(),
        }));

      if (toInsert.length) {
        await supabase.from('signals').insert(toInsert).then(({ error }) => {
          if (error) console.error('Failed to persist signals:', error);
        });
      }
    }

    return Response.json({
      signals: result.signals || [],
      analysis: result.analysis || '',
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('generate-signals error:', error);
    return Response.json({ error: (error as Error).message }, { status: 500, headers: corsHeaders });
  }
});
