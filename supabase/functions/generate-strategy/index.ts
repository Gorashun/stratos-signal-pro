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

    const { timeframe = 'swing', direction = 'long', focus = 'momentum', riskProfile = 'balanced' } = await req.json();

    const riskMap = { conservative: 0.003, balanced: 0.005, aggressive: 0.01 };
    const riskPct = riskMap[riskProfile] || 0.005;

    const prompt = `Du är en kvantitativ strateg med fokus på svenska och globala aktiemarknader.

Generera en regelbaserad handelsstrategi baserat på dessa inputs:
- Tidshorisont: ${timeframe} (day=daghandel, swing=2-10 dagar, position=veckor)
- Riktning: ${direction} (long=köpstrategi, short=blankning, both=båda)
- Fokus: ${focus} (momentum, mean_reversion, breakout, trend)
- Riskprofil: ${riskProfile} → ${riskPct * 100}% risk per affär

Returnera ENBART valid JSON med denna exakta struktur:
{
  "name": "string (kreativt svenskt namn)",
  "description": "string (en mening som beskriver strategin)",
  "entries": [
    {
      "name": "string",
      "all_of": [
        {"indicator": "ema20_gt_ema50", "value": true},
        {"indicator": "close_gt_sma200", "value": true},
        {"indicator": "rsi14", "op": ">", "value": 50}
      ]
    }
  ],
  "exits": [
    {"type": "atr_stop", "atr_mult": 2.5},
    {"type": "trailing_atr", "atr_mult": 3.5}
  ],
  "position_sizing": {
    "risk_per_trade": ${riskPct},
    "max_positions": 10,
    "max_sector_exposure": 0.25
  },
  "risk": {
    "max_drawdown": 0.12,
    "daily_loss_limit": 0.02
  },
  "regime": {
    "bear": {"allow_longs": false}
  }
}

Anpassa entry-regler för ${timeframe} ${direction} ${focus}. Inga kommentarer, bara JSON.`;

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

    let strategy = {};
    try {
      const clean = text.replace(/```json\n?|\n?```/g, '').trim();
      strategy = JSON.parse(clean);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) strategy = JSON.parse(match[0]);
    }

    return Response.json({ strategy }, { headers: corsHeaders });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500, headers: corsHeaders });
  }
});
