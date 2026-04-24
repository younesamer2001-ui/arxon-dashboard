# Arxon Command Center — Architecture

_Sist oppdatert: 24. april 2026_

## Oversikt

Arxon Command Center er dashboardet for å drive Arxon-virksomheten og gi kunder egne portaler. Dette dokumentet forklarer datamodellen, auth-systemet, multi-tenant-oppsettet og hvordan man legger til nye ting.

---

## Teknologi-stack

- **Frontend:** Én stor HTML-fil (`arxon-command-center.html`) med inline JS + Tailwind CSS (via CDN). Ingen build-steg.
- **Hosting:** Vercel (prosjekt `prj_2e2meRi3t9AIUE3yazwytuBziIZC`, team `team_8m3vQ6jNG6FQnQASUIzk4uB1`)
- **Domene:** `dashboard.arxon.no` (CNAME hos Domeneshop → cname.vercel-dns.com)
- **Database:** Supabase PostgreSQL (prosjekt `jifxdjctyhkywwldrrmj`)
- **Auth:** Supabase Auth + Google OAuth
- **Kode-deploy:** GitHub `younesamer2001-ui/arxon-dashboard` → Vercel auto-deploy på `main`-push

## Auth-flyt

1. Bruker går til `dashboard.arxon.no`
2. Hvis `localStorage.arxon_require_auth === '1'`: auth-gate vises (blokkerer dashboard)
3. Klikk "Logg inn med Google" → Supabase signInWithOAuth → Google consent → callback til `https://jifxdjctyhkywwldrrmj.supabase.co/auth/v1/callback` → redirect til dashboard med session
4. Session lagres i `localStorage` (supabase-js håndterer)
5. `window.loadSupabaseClient()` henter Supabase-klient med persistent session
6. Sjekk `user_profiles` for bruker: hvis ingen profil → vis "Kontakt Younes for tilgang"
7. Hvis profil finnes: `window.__authSession` + `window.__authProfile` settes, auth-gate skjules
8. `window.applyAuthToken(session)` bytter `H.Authorization` + `Hread.Authorization` fra anon-nøkkel til session-token → alle DB-kall går som autentisert bruker
9. `applyRoleBasedUI()` skjuler admin-tabs hvis bruker ikke er admin

## Datamodell

### Tenants

`public.tenants`:
- `id` (uuid, PK)
- `slug` (text, unik) — f.eks. "arxon", "holmlia-bilverksted"
- `name` (text) — firmanavn
- `plan` (text) — trial/starter/pro/enterprise
- `is_arxon` (boolean) — true kun for Arxon selv
- `created_at`, `updated_at`

### User profiles

`public.user_profiles`:
- `id` (uuid, PK → `auth.users.id`)
- `tenant_id` (uuid → `tenants.id`)
- `role` (text) — admin/member/viewer
- `full_name` (text)
- `created_at`, `updated_at`

Admin-sjekk: `public.is_arxon_admin()` = bruker er admin **og** tenant er Arxon.

### Datatabeller med tenant-isolasjon

Alle disse har `tenant_id`-kolonne (backfilled til Arxon):
- `contact_submissions`, `job_applications` (skjemaer fra nettsiden)
- `leads`, `customers` (CRM)
- `calls` (Vapi-samtaler)
- `calendar_events`, `tasks`, `milestones`, `ideas` (drift)
- `kanban_cards`, `work_plans`, `onboarding_tasks` (prosjekter)
- ...og flere

### RLS (Row-Level Security)

Hver datatabell har policyen `arxon_admin_all`: admin kan gjøre alt. For ikke-admin brukere legges det til `tenant_own_*`-policyer (SELECT) som filtrerer på `tenant_id = public.current_tenant_id()` (ikke implementert for alle ennå — tenant-isolation for customer users skjer i Fase 3+).

### Invite-flyt

1. Admin klikker "Inviter bruker" på en tenant, skriver inn e-post + rolle
2. Hvis brukeren allerede finnes i `auth.users`: oppretter `user_profiles`-rad direkte
3. Hvis ikke: `pending_invites`-rad lagres. Første gang brukeren logger inn med Google, fyrer `on_auth_user_created`-triggeren og oppretter profil automatisk fra invitasjonen.

---

## Deploy-pipeline

```
[Edit sandbox HTML] → [git commit + push i /tmp/test-clone] → [GitHub main]
                    → [Vercel auto-deploy] → [dashboard.arxon.no live i ~30s]
```

Supabase-endringer går via MCP `apply_migration` eller SQL Editor.

## Slik legger du til en ny tab

1. Legg til `<button data-tab="mintab">` i sidebar
2. Legg til `<section class="section hidden" id="sec-mintab">` med innhold
3. I `switchTab()`-funksjonen: `if (tab === 'mintab') loadMintab();`
4. Skriv `loadMintab()` + `renderMintab()` som leser fra Supabase via `q('tabell', '...')` og rendrer
5. Commit + push → auto-deploy

## Slik legger du til en ny kunde-tenant

1. Logg inn som admin på `dashboard.arxon.no`
2. Klikk "Tenants" i sidebar
3. Klikk "+ Ny tenant" → fyll ut navn + plan → Opprett
4. Klikk "Inviter bruker" → skriv inn kundens Google-e-post + rolle
5. Be kunden gå til dashboard.arxon.no og logge inn med Google
6. Profilen opprettes automatisk, de ser kun sin egen tenant-data

## Vanlige feilsøkingspunkter

- **Dashboard krever login men ingen skjerm:** Sett `localStorage.removeItem('arxon_require_auth'); location.reload()` i DevTools
- **"Ingen bruker-profil funnet":** Auth.user finnes, men `user_profiles` har ingen rad. Admin må opprette via Tenants-tab eller kjøre SQL-insert manuelt.
- **"42501 permission denied":** GRANT mangler på tabellen. Kjør `GRANT SELECT, INSERT, UPDATE ON public.TABELL TO authenticated;`
- **Tenant-rad ikke synlig:** Bruker er ikke admin ELLER tenant_id er null. Sjekk user_profiles.
