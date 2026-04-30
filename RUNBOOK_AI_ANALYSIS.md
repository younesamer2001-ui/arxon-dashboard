# Runbook — AI-analyse + PDF-eksport for Samtaler

> Lagt til 2026-04-30
> Hva som ble bygget, hvordan deploye, hvordan teste

---

## Hva er nytt

To nye funksjoner i Samtaler-tabben:

### 1. Per-samtale AI-analyse

Klikk på en samtale → modal åpnes → ny **🤖 AI-analyse**-knapp i toppen.

Trykk knappen → Vercel-funksjon `/api/analyze-call` kaller GPT-4o-mini → returnerer strukturert vurdering:
- Score 1-10
- Kundens intensjon (én setning)
- Hvordan det faktisk gikk
- Hva funket (3-5 bullets)
- Hva feilet (3-5 bullets)
- Konkrete forbedringspunkter (3-5 bullets)
- Detekterte problem-kategorier (intent_recognition, language, booking, escalation, tone, other)

Resultatet lagres i `public.call_analyses`-tabellen og vises i modalen. Neste gang du åpner samme samtale lastes analysen automatisk fra DB (ingen ny LLM-kall).

### 2. AI-trend-analyse på tvers av samtaler

I Samtaler-toppen, ny **🤖 AI-trender**-knapp. Åpner egen modal.

Velg periode (3/7/14/30 dager) → Vercel-funksjon `/api/analyze-calls-aggregate` leser opptil 30 samtaler → GPT-4o-mini finner mønstre på tvers:
- Helhetsvurdering
- Topp-anbefalinger (sortert etter prioritet 1-3)
- Gjentatte spørsmål AI-en feilet på
- Identifiserte mønstre (med kategori og frekvens)
- Hva funket konsistent
- Metric-summary (vellykkede vs. feilede)

### 3. PDF-eksport

I begge modalene: **📄 PDF**-knapp.
- Per-samtale: laster ned PDF med metadata, sammendrag, AI-analyse (hvis kjørt), full transkript
- Trend-analyse: laster ned PDF med alle anbefalinger og mønstre

Bruker jsPDF i nettleseren — ingen server-side PDF-generation, ingen build-step.

---

## Deploy-sjekkliste

### Trinn 1: Kjør Supabase-migrasjon

```bash
# Åpne Supabase SQL Editor (https://supabase.com/dashboard/project/jifxdjctyhkywwldrrmj/sql)
# Lim inn innhold fra supabase-migrations/002_call_analyses.sql
# Klikk RUN
```

Verifiser:
```sql
select count(*) from public.call_analyses;  -- skal være 0
select pg_get_functiondef('public.latest_call_analysis(uuid)'::regprocedure);  -- skal returnere funksjonsdef
```

### Trinn 2: Sett env vars i Vercel

Logg inn på Vercel → arxon-command-center → Settings → Environment Variables.

Legg til disse for **Production + Preview + Development**:

| Variabel | Verdi |
|---|---|
| `OPENAI_API_KEY` | sk-... fra https://platform.openai.com/api-keys |
| `SUPABASE_SERVICE_ROLE_KEY` | Hent fra Supabase → Settings → API → `service_role` key |
| `SUPABASE_URL` | https://jifxdjctyhkywwldrrmj.supabase.co (default i kode) |

### Trinn 3: Push til GitHub

```bash
cd ~/Desktop/Arxon/arxon-command-center
git add api/ vercel.json package.json arxon-command-center.html supabase-migrations/002_call_analyses.sql RUNBOOK_AI_ANALYSIS.md
git commit -m "Legg til AI-analyse + PDF-eksport for samtaler"
git push
```

Vercel auto-deploy fra `main`. Siden vi byttet `vercel.json` fra `@vercel/static` til `rewrites`+`functions`, vil første deploy ta litt lengre tid (~60 sek) fordi Vercel oppdager funksjonene.

### Trinn 4: Verifiser

1. Åpne https://dashboard.arxon.no
2. Logg inn (Google SSO)
3. Gå til Samtaler-tab
4. Klikk på en samtale med transkript
5. Klikk "🤖 AI-analyse"
6. Vent 5-15 sek → analysen skal vises under transkriptet
7. Klikk "📄 PDF" → lastes ned `arxon-samtale-...pdf`

For trend-analyse:
1. Klikk "🤖 AI-trender" øverst
2. Velg periode
3. Klikk "Kjør analyse"
4. Vent 15-40 sek → mønstre + anbefalinger vises
5. Klikk "📄 PDF" → lastes ned `arxon-trend-rapport-...pdf`

---

## Troubleshooting

### "OPENAI_API_KEY mangler i Vercel env vars"
Sett env var i Vercel → Redeploy.

### "SUPABASE_SERVICE_ROLE_KEY mangler"
Hent fra Supabase Settings → API → service_role (NB: denne er hemmelig, server-side only).

### "Mangler Authorization-header"
Brukeren er ikke logget inn med gyldig session. Logg ut + inn igjen.

### "Samtale ikke funnet" eller "Samtalen mangler transkript"
Vapi har ikke skrevet transkript til DB ennå, eller samtalen er for kort. Vent eller velg en annen.

### PDF-eksport gjør ingenting
Sjekk at jsPDF + html2canvas-skriptene er lastet (nettverk-fanen i DevTools). De ligger i CDN-tags i `<head>`.

### AI-analyse-modal viser feil "HTTP 500"
Sjekk Vercel runtime-logs:
```bash
vercel logs --project arxon-command-center
```

### Trend-analyse er for treg eller cutt-off
Periode-valget begrenses til maks 30 samtaler i en LLM-kall. Hvis du har flere — del opp i mindre perioder. Total kostnad per kjøring er ~0.30 kr (gpt-4o-mini er billig).

---

## Kostnad

Per single-call analyse: ~0.05-0.10 kr (typisk transkript ~1000 tokens input + ~400 output)
Per trend-analyse (30 samtaler): ~0.20-0.40 kr

Hvis Arxon kjører single-call analyse på alle ~500 samtaler/uke: ~25-50 kr/uke = 100-200 kr/mnd. Trivielt.

---

## Hva som er lagret hvor

```
public.calls                  ← Vapi-samtaler (eksisterer fra før)
public.call_analyses          ← NY tabell: alle AI-analyser (single + aggregate)
public.latest_call_analysis() ← funksjon: hent siste single-call-analyse for en samtale
public.call_analysis_problem_patterns ← view: aggregert telling av problem-kategorier per tenant
```

API-endepunkter:
- `POST /api/analyze-call` body: `{callId}` → analyserer + lagrer
- `POST /api/analyze-calls-aggregate` body: `{days?, maxCalls?, tenantId?}` → analyserer + lagrer

Begge krever `Authorization: Bearer <supabase-session-token>` (samme som dashboardet bruker for q()).

---

## Hva som mangler (todo)

- [ ] Auto-analyse av nye samtaler (cron eller webhook fra Vapi → /api/analyze-call automatisk)
- [ ] Email-rapport hver mandag morgen (Resend) med ukens trend-analyse vedlagt som PDF
- [ ] Visualisering av problem-pattern over tid (graf på Hjem-tab)
- [ ] Sammenligne to perioder ("Måned 1 vs måned 2")
- [ ] Drill-down: klikk på en problem-kategori → vis alle samtaler som har den

Disse kan bygges senere — kjernen funker nå.
