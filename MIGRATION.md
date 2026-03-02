# StratOS Signal Pro v2 — Migration Guide
## Base44 → Supabase

---

## Vad som har förändrats

| Komponent | Förut (Base44) | Nu (Supabase) |
|---|---|---|
| **Backend** | Base44 Edge Functions | Supabase Edge Functions (samma Deno-runtime) |
| **Databas** | Base44 entities | Supabase Postgres med RLS |
| **Auth** | Base44 auth | Supabase Auth |
| **AI** | `base44.integrations.Core.InvokeLLM()` | Direct Anthropic API call |
| **Priskälla** | Alpha Vantage (primär, dålig SE-täckning) | Twelve Data (primär, bäst för .ST) |
| **Exchange-mappning** | Inkonsekvent/fel | Korrekt: `sweden → XSTO`, `uk → XLON` etc |
| **Instrument-discovery** | Statisk lista (196 aktier) | Live från Nasdaq + statisk fallback |
| **Fake-data fallback** | Returnerar 100 SEK som platshållare | Returnerar `null` — ingen fejkdata |

---

## Steg 1: Skapa Supabase-projekt

1. Gå till [supabase.com](https://supabase.com) → New project
2. Välj en region nära Sverige (eu-central-1 Frankfurt är närmast)
3. Kopiera `Project URL` och `anon public key` från Settings → API

---

## Steg 2: Sätt upp databasen

Öppna Supabase Dashboard → SQL Editor och kör hela `supabase/schema.sql`.

Det skapar:
- `instruments` — aktieregister (delat, ingen RLS)
- `signals` — AI-genererade handelssignaler (per användare)
- `trades` — portföljaffärer (per användare)
- `watchlist` — bevakningslista (per användare)
- `user_settings` — inställningar inkl sparad strategi
- `backtests` — backtestresultat

---

## Steg 3: Konfigurera miljövariabler

```bash
cp env.example .env.local
# Fyll i VITE_SUPABASE_URL och VITE_SUPABASE_ANON_KEY
```

---

## Steg 4: Sätt secrets för Edge Functions

Via Supabase Dashboard → Edge Functions → Manage secrets:

```
ANTHROPIC_API_KEY    = sk-ant-...       (krävs för AI-signaler)
TWELVE_DATA_API_KEY  = xxxx             (primär priskälla)
FINNHUB_API_KEY      = xxxx             (fallback)
ALPHA_VANTAGE_API_KEY = xxxx            (valfri)
```

Eller via CLI:
```bash
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
npx supabase secrets set TWELVE_DATA_API_KEY=your-key
npx supabase secrets set FINNHUB_API_KEY=your-key
```

Twelve Data: https://twelvedata.com (gratisnivå: 800 req/dag, räcker för ~160 aktier/dag)
Finnhub: https://finnhub.io (gratisnivå: 60 req/min)

---

## Steg 5: Deploya Edge Functions

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_ID

# Deploya alla på en gång:
npm run supabase:deploy:all

# Eller individuellt:
npx supabase functions deploy market-data
npx supabase functions deploy generate-signals
npx supabase functions deploy generate-strategy
npx supabase functions deploy analyze-signal
npx supabase functions deploy backtest
npx supabase functions deploy sync-instruments
```

---

## Steg 6: Synka instrument

När du är inloggad i appen, gå till Inställningar → klicka "Synka instrument".

Det kör `sync-instruments` edge function som:
1. Försöker hämta live-lista från Nasdaq Nordic API
2. Fallback: seeder de 80+ manuella instrumenten i koden
3. Lägger till XSTO-korrekt symbolmappning för Twelve Data

---

## Steg 7: Installera och kör frontend

```bash
npm install
npm run dev
```

---

## Kodändringar i frontend

Byt ut alla importer som pekar på base44:

```js
// Förut
import { base44 } from '@/api/base44Client';
await base44.functions.invoke('fetchMarketData', { tickers });
await base44.entities.Instrument.list('-created_date', 5000);

// Nu
import { invokeFunction, Instrument } from '@/api/supabaseClient';
await invokeFunction('market-data', { tickers });
await Instrument.list();
```

Auth:
```js
// Förut
import { AuthContext } from '@/lib/AuthContext'; // base44 version

// Nu
import { useAuth } from '@/lib/AuthContext'; // supabase version
const { user, signIn, signOut } = useAuth();
```

---

## Arkitektur — Edge Functions

```
market-data          ← Hämtar priser (Twelve Data → Finnhub → Alpha → Yahoo)
generate-signals     ← AI-analys via Anthropic API, persisterar signaler till DB
generate-strategy    ← Genererar regelbaserad strategi via AI
analyze-signal       ← Djupanalys av enskild signal
backtest             ← Historisk simulering via Yahoo Finance history
sync-instruments     ← Synkar instrument från Nasdaq Nordic + seed-data
```

---

## Varför Twelve Data?

- Bäst täckning för Nasdaq Stockholm (.ST-aktier)
- Korrekt historisk data för indikatorberäkning (200 dagars historia)
- Returnerar volym, OHLC, procentförändring i ett anrop
- Gratis tier: 800 req/dag = räcker för daglig uppdatering av ~200 aktier

Symbol-format för Twelve Data:
- Sverige: `ERIC-B:XSTO`
- USA: `AAPL` (ingen suffix)
- London: `SHEL:XLON`
- Frankfurt: `SAP:XETR`

---

## Vad som är kvar att migrera

Dessa filer behöver uppdateras för att byta ut `base44`-importer:

- `src/components/stratos/DashboardPage.jsx`
- `src/components/stratos/PortfolioPage.jsx`
- `src/components/stratos/WatchlistPage.jsx`
- `src/components/stratos/SettingsPage.jsx`
- `src/components/stratos/StrategyPage.jsx`
- `src/components/stratos/UniversePage.jsx`
- `src/components/stratos/SignalsPage.jsx`

Alla dessa importerar antingen `base44.entities.*` eller `base44.functions.invoke()`.
Byt mot motsvarande från `@/api/supabaseClient.js`.

---

## Skalning — Fler aktier

För att gå från ~200 → 1000+ aktier:

1. **Twelve Data Business plan** (~$29/mån) ger 5000 req/dag
2. **Nasdaq Nordic CSV-export**: `https://www.nasdaqomxnordic.com/shares/listed-companies/stockholm` 
   — Ladda ned CSV, parsa och bulk-insert via `sync-instruments`
3. **Cron-job**: Supabase har inbyggd cron via `pg_cron` extension — sätt upp daglig prisuppdatering:

```sql
-- Aktivera i Supabase Dashboard → Extensions → pg_cron
SELECT cron.schedule('update-prices', '0 18 * * 1-5', $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT.supabase.co/functions/v1/market-data',
    headers := '{"Authorization": "Bearer SERVICE_ROLE_KEY"}'::jsonb
  );
$$);
```
