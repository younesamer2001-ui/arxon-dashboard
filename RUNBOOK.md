# Arxon Command Center — Runbook

_Vanlige operasjonelle oppgaver. Sist oppdatert: 24. april 2026_

## Daglig

### Sjekke at dashboardet er oppe
- Åpne `https://dashboard.arxon.no` — skal gi login-skjerm eller dashboard
- Sjekk Vercel: https://vercel.com/yoyokoks-projects/arxon-command-center → nyeste deploy skal være READY
- Supabase health: https://supabase.com/dashboard/project/jifxdjctyhkywwldrrmj — Database status grønn

### Se innkommende henvendelser + søknader
- Logg inn → "Kontakt" eller "Karriere" i sidebar
- Kanban-toggle for å se statuspipeline
- Klikk kort for detaljer → "Åpne i e-post" for å svare

## Ukentlig

### Se hvilke deploys har skjedd
- GitHub: https://github.com/younesamer2001-ui/arxon-dashboard/commits/main
- Vercel: https://vercel.com/yoyokoks-projects/arxon-command-center/deployments

### Rotere anon-nøkkelen i Supabase
Hvis mistenkelig aktivitet: Supabase → Settings → API → Reset anon key. Oppdater så fallback-nøkkelen i `arxon-command-center.html` + alle miljøvariabler på Vercel.

## Når det trengs

### Opprette ny kunde-tenant
1. Logg inn som admin på dashboard.arxon.no
2. Tenants-tab → "+ Ny tenant"
3. Skriv firmanavn → auto-generert slug → velg plan → Opprett
4. Klikk "Inviter bruker" på den nye tenant-raden
5. Legg inn e-post + rolle (member anbefales for kunder) → Inviter
6. Be kunden logge inn med Google på dashboard.arxon.no første gang

### Slette en tenant
- Tenants-tab → slett-knapp (søppelikon) → bekreft
- Alle brukere kobles fra, men data beholdes

### Rulle tilbake en dårlig deploy
- Vercel → Deployments → finn forrige gode → `...` → Promote eller Instant Rollback

### Rotere Vercel-token (som Claude bruker)
Hvis Claude-tokenet må fornyes:
1. https://vercel.com/account/tokens → slett gammelt
2. Opprett nytt: "Claude Auto-Deploy", Full Account scope
3. Erstatt i conversation når Claude spør

### Rotere GitHub PAT
- https://github.com/settings/tokens → slett gammel
- Opprett ny med `repo` scope
- Claude pusher til `git remote set-url origin https://younesamer2001-ui:NY_TOKEN@github.com/younesamer2001-ui/arxon-dashboard.git`

## Når noe er galt

### Kan ikke logge inn
1. Sjekk at Google OAuth-appen er i "In production" i Google Cloud
2. Sjekk at `dashboard.arxon.no` er i Supabase URL Config → Site URL + Redirect URLs
3. Prøv Inkognito for å unngå cache-problemer
4. Åpne DevTools Console → se errors → del med Claude

### Skjema på arxon.no funker ikke
1. Sjekk Vercel runtime logs for nettsiden (prosjekt `arxonelivesite`)
2. Verify `SUPABASE_SERVICE_ROLE_KEY` er satt i Vercel env
3. Kjør test-POST mot `/api/contact` fra DevTools Console — sjekk response

### Data forsvinner / ikke synlig
- Sjekk RLS-policyer i Supabase Dashboard → Authentication → Policies
- Admin skal ha `arxon_admin_all`-policy på alle tabeller
- Sjekk `is_arxon_admin()` SQL-funksjon returnerer true for din bruker:
  ```sql
  select public.is_arxon_admin();
  ```

### Tenant-isolasjon feiler
- Verifiser `user_profiles.tenant_id` er satt riktig for brukeren
- Verifiser `current_tenant_id()` returnerer riktig: `select public.current_tenant_id();` mens innlogget som den brukeren

## Nøkler og secrets (aldri commit til git)

- Supabase service_role key — kun i Vercel env for nettside
- Vercel API token — Claude bruker den
- GitHub PAT — Claude bruker den
- Google OAuth Client Secret — kun i Supabase Auth settings

Alle står listet i Last-Pass / 1Password. Hvis ikke: se "Rotere"-seksjonene over.
