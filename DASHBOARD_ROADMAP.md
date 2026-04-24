# Arxon Dashboard — Roadmap & Runbook

_Sist oppdatert: 24. april 2026 · 23:40_

## Status per fase

| Fase | Status |
|------|--------|
| 1 — Rydding & fundament | ✅ ferdig |
| 2 — Sikkerhet (auth-gate, Google SSO) | ✅ ferdig |
| 2.5 — Session-token, RLS-stramming | ✅ ferdig |
| 3 — Multi-tenant UI, invite-flyt | ✅ ferdig |
| 4 — Design-system | 🟡 påbegynt (CSS-var rammeverk ikke fullt utrullet) |
| 5 — Dokumentasjon (ARCHITECTURE, RUNBOOK) | ✅ ferdig |

**Pipeline status:** GitHub → Vercel auto-deploy. Claude pusher direkte, endringer live på ~30 sek. **Ingen manuell deploy trengs.**


Dette dokumentet er Arxons kart for hvordan vi gjør dashboardet profesjonelt, sikkert, multi-tenant og en ekte command center for drift. Hver fase har konkrete steg, checkliste og exit-kriterier. Gå sekvensielt.

---

## 0. Dagens tilstand (audit 24. april 2026)

- **Tabs:** 15 (Hjem, Pipeline, Prospektering, Kunder, Kalender, Tilbud, Automatisering, Samtaler, Kontakt, Karriere, Innboks, E-post, Analyse, Fakturering, Innstillinger)
- **Data:** 107 samtaler, 19 leads, 2 kunder, 14 henvendelser, 5 jobbsøknader
- **Auth:** ingen. Alle med dashboard-URL ser alt.
- **Database:** Supabase med anon-nøkkel eksponert i HTML. RLS finnes, men policyene er slappe.
- **Hosting:** Vercel (prj_2e2meRi3t9AIUE3yazwytuBziIZC, team_8m3vQ6jNG6FQnQASUIzk4uB1).
- **Kode:** én stor HTML-fil på ~9 800 linjer (inline JS + CSS). Ingen build-steg, ingen tester.

**Kritiske risikoer:**
- Hvem som helst som gjetter/får delt URL-en kan lese kundelister, samtaler og henvendelser.
- Anon-nøkkelen i klient-HTML gir INSERT/UPDATE på flere tabeller.
- Ingen audit-logg på hvem som har gjort hva.
- Ingen brukerstøtte — derfor heller ingen multi-tenant.

---

## Fase 1 — Ryddesøl og fundament (1–2 dager)

**Mål:** Et rent, testbart fundament vi kan bygge videre på uten å dra med oss teknisk gjeld.

### 1.1 Test at alt fungerer
- [ ] Kjør end-to-end-test av hver tab med Claude-in-Chrome (eller manuelt). Noter alt som er broken, tregt eller forvirrende.
- [ ] Verifiser at Kontakt + Karriere: innsending → dashboard → status-endring → slett fungerer for begge skjemaer.
- [ ] Verifiser at kanban-drag-drop flytter kort og lagrer status i DB.
- [ ] Verifiser at detalj-modal åpner, at "Åpne i e-post" fyller inn korrekt mottaker + emne.
- [ ] Verifiser at push-varsling utløses ved ny rad (åpne Kontakt-skjemaet på arxon.no, send en ny innsending, sjekk at varsling dukker opp i dashboardet).
- [ ] Samtaler-tab: se at nye Vapi-samtaler kommer inn og at sammendrag er komplette.

### 1.2 Fjern det som står i veien
- [ ] Slett debug-kode (f.eks. diagnostic GET-handler i `/api/contact/route.ts` hvis den er på plass).
- [ ] Rydd opp ubrukte tabs hvis noen er tomme og aldri brukes (E-post? Automatisering? Tilbud?). Foreslå fjerning eller skjuling bak "Kommer".
- [ ] Fjern gamle bakup-HTML-filer (`_HXeBZ2Vdo.html`, `_v3_apr11_backup.html`).
- [ ] Fjern hardkodede nøkler som ikke brukes.

### 1.3 Fikse løse tråder
- [ ] Sett `SUPABASE_SERVICE_ROLE_KEY` som env-variabel på Vercel (Production + Preview) for `arxonelivesite`-prosjektet. Da bruker `/api/contact` og `/api/career` service-role (bypass RLS) og trenger ikke de åpne anon-policiene.
- [ ] Roter anon-nøkkelen i Supabase (Settings → API → Reset anon key) etter at service-role er på plass.
- [ ] Verifiser at Resend sender til `kontakt@arxon.no`. Hvis ikke, gjennomfør domain verification i Resend (arxon.no) og sett `from: 'Arxon <noreply@arxon.no>'`.
- [ ] Legg til `.gitignore` for `.env.local` og bekreft at ingen nøkler ligger i git-historikken.

### Exit-kriterier Fase 1
- Alle tabs fungerer eller er skjult med "Kommer snart".
- Alle formsubmissions lander i DB + e-post.
- Service-role satt; anon-policyer strammet inn til kun lesing av ikke-sensitive felt.

---

## Fase 2 — Sikkerhet (2–3 dager)

**Mål:** Ingen skal kunne se dashboardet uten å logge inn.

### 2.1 Supabase Auth
- [ ] Slå på Supabase Auth (Email+password, Magic link eller SSO via Google).
- [ ] Lag `users`-tabell eller utvid `auth.users` med rollekolonne: `role text check (role in ('admin','customer')) default 'customer'`.
- [ ] Opprett din egen bruker med `role = 'admin'`.

### 2.2 RLS-stramming
- [ ] Slett `"Allow anonymous inserts"`, `"Allow updates"`, `"anon_read_*"` for alle tabeller unntatt `contact_submissions` og `job_applications` (skjemaer må kunne skrive fra nettsiden).
- [ ] Erstatt med auth-baserte policyer: `authenticated` + `role = 'admin'` får SELECT/INSERT/UPDATE/DELETE på alle rader.
- [ ] For skjema-tabellene: behold `anon INSERT` (skjemaer), men fjern `anon SELECT` og `anon UPDATE`. Dashboardet leser + oppdaterer via auth-brukerens token (admin).

### 2.3 Auth-gate i dashboard-HTML
- [ ] Hvis bruker ikke er logget inn: vis login-form, ellers vis dashboard.
- [ ] Bruk `supabase.auth.getSession()` ved load. Ved logout: `supabase.auth.signOut()` + reload.
- [ ] Lagre tokens i localStorage via supabase-js (den håndterer det).
- [ ] Bytt alle `q(...)` / `fetch(...)` fra anon-nøkkel til `supabase.from(...).select(...)` (auth-aware).

### Exit-kriterier Fase 2
- Dashboardet krever login.
- Anon-nøkkelen kan ikke lese noen av dashboard-tabellene.
- Kun admins ser data i dag.
- Du har testet at logout fungerer og at en annen browser uten token får tom side.

---

## Fase 3 — Multi-tenant (3–5 dager)

**Mål:** Andre bedrifter kan få sitt eget dashboard, scoped til deres egen data.

### 3.1 Datamodell
- [ ] Legg til `tenants`-tabell (id, name, slug, plan, created_at, arxon_revenue_share).
- [ ] Legg til `tenant_id uuid references tenants(id)` på alle relevante tabeller (`leads`, `customers`, `calls`, `contact_submissions`, `job_applications`).
- [ ] Utvid `users`-tabellen: `tenant_id uuid references tenants(id)`.
- [ ] Opprett `Arxon`-tenant som referansepunkt.

### 3.2 RLS med tenant-isolation
- [ ] Oppdater alle policyer til å sjekke `tenant_id = auth.jwt() -> 'app_metadata' -> 'tenant_id'`.
- [ ] Admin-bruker (f.eks. deg) hos Arxon får spesialpolicy som overstyrer tenant-filter: `role = 'admin' AND tenant = 'Arxon'` → alle rader.

### 3.3 Rollebasert UI
- [ ] Lag `getCurrentUser()` som returnerer `{id, tenant_id, role}`.
- [ ] I sidebar: skjul tabs som ikke er relevante for kundene (Prospektering, Arxons egen Analyse-side).
- [ ] Kunde-visning av Analyse: bare deres egen omsetning/samtaler — ikke Arxons totale bookinntjening.
- [ ] Admin-visning: ekstra "Tenants"-tab hvor du kan bytte perspektiv, opprette nye tenants, invitere brukere.

### 3.4 Invite-flyt
- [ ] Admin klikker "Opprett kunde" → sender magic-link e-post via Supabase Auth med tenant_id i app_metadata.
- [ ] Kundens første innlogging → kundeportal (egen sub-view).

### Exit-kriterier Fase 3
- Du kan logge inn som admin og se alt.
- Du kan opprette en test-tenant, invitere en test-bruker, og verifisere at den brukeren bare ser sin egen data.
- Ingen måte å komme seg på tvers av tenants uten admin.

---

## Fase 4 — Design-løft (2–3 dager)

**Mål:** Dashboardet skal føles premium. Konsistent, rolig, raskt.

### 4.1 Design-system
- [ ] Lag en `:root`-seksjon med CSS-variabler for farger, spacing, radius, font-sizes.
- [ ] Dokumenter farge- og typografi-systemet i `DESIGN_SYSTEM.md`.
- [ ] Bytt alle hardkodede `rgb(...)` i komponenter til `var(--color-*)`.

### 4.2 Layoutkorreksjon
- [ ] Ensartet section-header på alle tabs (title, subtitle, primæraksjon).
- [ ] Ensartet empty state på alle lister.
- [ ] Ensartet toast + modal-system.
- [ ] Smooth transitions mellom tabs (fade).

### 4.3 Mørkt → tema
- [ ] Behold mørk modus som standard, men sørg for at lys modus faktisk fungerer (tester viser noen hardkodede farger som ikke bytter).
- [ ] Sjekk `setTheme()`-flyten på hver tab.

### 4.4 Mikro-interaksjoner
- [ ] Subtile hover-effekter på kort.
- [ ] Ripple eller scale på knapper.
- [ ] Loading-skeletons over alt (ikke bare Kontakt/Karriere).
- [ ] Sortér toast-feedback med retningslys (grønn, rød, blå).

### Exit-kriterier Fase 4
- Dashboardet skal se profesjonelt ut på både desktop og mobil.
- Ingen layout-shift ved tab-bytte.
- Alt under 200 ms opplevd responstid.

---

## Fase 5 — Skalering og rutiner (pågående)

**Mål:** Dashboardet er vedlikeholdbart og sikkert å iterere på.

### 5.1 Kodebase-modularisering
- [ ] Del opp den store HTML-filen i flere mindre moduler (f.eks. `/sections/kontakt.js`, `/sections/samtaler.js`, inkluder via `<script>`-tags eller med en enkel bundle-prosess).
- [ ] Eller migrer til Next.js / Vite hvis bundling blir for tungt å ikke ha.

### 5.2 CI & kvalitet
- [ ] Legg til en `npm run check`-kommando som kjører Prettier + en enkel HTML-validator.
- [ ] Sett opp Vercel preview-deploys for pull requests.

### 5.3 Observability
- [ ] Legg til Vercel Analytics eller Umami.
- [ ] Logg errors fra client til et sted (Sentry? Supabase-tabell `client_errors`?).
- [ ] Audit-logg på alle admin-handlinger (tenant opprettet, bruker invitert, rad slettet).

### 5.4 Dokumentasjon
- [ ] Oppdater denne filen etter hver fase (legg til dato + hva som ble gjort).
- [ ] `ARCHITECTURE.md` — kort oversikt over datamodell, auth, tenants, hvordan legge til en ny tab.
- [ ] `RUNBOOK.md` — hvordan gjøre vanlige ting (opprette kunde, rotere nøkkel, feilsøke ingen-innsendinger).

---

## Rutiner (gjenta ukentlig)

### Mandag — "hvordan har dashboardet det?"
- Sjekk Vercel deployments: var alle siste uke `READY` eller har noen feilet?
- Sjekk Vercel runtime logs for 500-feil. Finn rot.
- Gå til Supabase → Logs → se siste 100 errors.
- Kjør en test-innsending på arxon.no/#kontakt og arxon.no/karriere. Lander de i dashboardet?

### Onsdag — "fungerer kundenes ting?"
- Ta en sjekk som admin → bytt til en test-tenant → bekreft at du ikke ser Arxons egne data.
- Logg ut. Prøv å åpne `/` i incognito. Får du login-skjerm?

### Fredag — "hvordan forbedrer vi?"
- Se på hvilke tabs du brukte i denne uken. Noen du aldri rører? Skjul dem.
- Er det friksjon? Ta 5 min til å skrive et punkt i `DASHBOARD_TODO.md`.
- Har du fått tilbakemelding fra noen kunde? Notér.

---

## Quick wins vi gjør NÅ (24. april 2026)

1. ✅ Kontakt + Karriere rør fungerer end-to-end (fikset `42501` GRANT-hull)
2. ✅ Status-pipeline + slett + kanban + push + detalj-modal (deployed)
3. ✅ Performance: cache-first, skeleton, prefetch
4. [ ] Fjern `_HXeBZ2Vdo.html` og `_v3_apr11_backup.html` (backup-filer som kladder opp)
5. [ ] Fjern debug GET-handler i `/api/contact/route.ts` (hvis pushet)
6. [ ] Sett `SUPABASE_SERVICE_ROLE_KEY` på Vercel Prod (hvis ikke allerede)
7. [ ] Kjør et fullt audit-runde av alle tabs (se Fase 1.1-liste)

---

## Beslutninger — LÅST INN 24. april 2026

1. **Auth:** Supabase Auth med **Google SSO**. Ingen magic-link, ingen passord. Kun «Logg inn med Google».
2. **Multi-tenant:** Én app (`dashboard.arxon.no`) for alle. Supabase RLS filtrerer dataene basert på tenant_id.
3. **Admin:** Kun Younes i starten. Arxon er sin egen tenant med `role = 'admin'`. Senere kan flere ansatte få admin-tilgang.
4. **Tenant-provisjonering:** Manuell. Du oppretter kunde-tenant + sender Google-invitasjon fra dashboardet.

### Tab-struktur (lock-in)

Gammel struktur (15 tabs) var for spredt. Ny struktur etter rydding:

**Hoved (daglig drift)**
- Hjem · Innboks (Kontakt + Karriere samlet) · Samtaler · Kalender

**Salg**
- Pipeline (leads + prospekter samlet) · Kunder

**Drift**
- Analyse · Fakturering

**System**
- Innstillinger

**Ikke i primærnavigasjon:** Automatisering (skjult til noe er bygget), E-post (overlappet Innboks, fjernet), Tilbud (skjult til det finnes signerte tilbud å vise). Kontakt + Karriere beholdes som dypere rute i Innboks-panelet.

---

## Slik jobber vi med dette

Ved hver session:

1. Åpne denne filen.
2. Sjekk fase vi er på.
3. Velg én task med `[ ]` (åpent).
4. Kryss av `[x]` når ferdig + noter dato.
5. Oppdater `Sist oppdatert`-dato i topp.

Vi går ikke til neste fase før alle exit-kriteriene er møtt.
