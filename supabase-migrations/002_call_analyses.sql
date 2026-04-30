-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION 002 — call_analyses-tabell for AI-drevet samtaleanalyse
-- ═══════════════════════════════════════════════════════════════════
-- Apply via Supabase SQL Editor eller `supabase db push`.
-- Gjør backup først.

-- ── 1. call_analyses-tabell ────────────────────────────────────────────
create table if not exists public.call_analyses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  call_id uuid references public.calls(id) on delete cascade,

  analysis_type text not null check (analysis_type in ('single_call', 'aggregate')),
  scope_label text,

  -- Single-call analysis fields
  overall_score int check (overall_score >= 1 and overall_score <= 10),
  customer_intent text,
  outcome_assessment text,
  what_worked jsonb default '[]'::jsonb,
  what_failed jsonb default '[]'::jsonb,
  suggested_fixes jsonb default '[]'::jsonb,
  detected_problems jsonb default '[]'::jsonb,

  -- Aggregate fields
  date_range_start timestamptz,
  date_range_end timestamptz,
  call_count int,
  patterns jsonb default '[]'::jsonb,
  top_questions_failed jsonb default '[]'::jsonb,
  recommendations jsonb default '[]'::jsonb,

  -- Raw + meta
  raw_response jsonb,
  model_used text default 'gpt-4o-mini',
  cost_usd numeric(10,4),

  created_at timestamptz default now(),
  created_by uuid references auth.users(id) on delete set null
);

-- Indekser
create index if not exists idx_call_analyses_call_id on public.call_analyses(call_id);
create index if not exists idx_call_analyses_tenant_id on public.call_analyses(tenant_id);
create index if not exists idx_call_analyses_type_created on public.call_analyses(analysis_type, created_at desc);

-- ── 2. RLS ──────────────────────────────────────────────────────────────
alter table public.call_analyses enable row level security;

-- Admin-policy (Arxon-admin kan alt)
drop policy if exists arxon_admin_all on public.call_analyses;
create policy arxon_admin_all on public.call_analyses
  for all
  using (public.is_arxon_admin())
  with check (public.is_arxon_admin());

-- Tenant-isolert SELECT for ikke-admin brukere
drop policy if exists tenant_own_select on public.call_analyses;
create policy tenant_own_select on public.call_analyses
  for select
  using (tenant_id = public.current_tenant_id());

-- INSERT må gå via service-role eller admin
drop policy if exists tenant_own_insert on public.call_analyses;
create policy tenant_own_insert on public.call_analyses
  for insert
  with check (
    public.is_arxon_admin()
    or tenant_id = public.current_tenant_id()
  );

-- Grants
grant select, insert, update, delete on public.call_analyses to authenticated;
grant select, insert, update, delete on public.call_analyses to service_role;

-- ── 3. Helper-funksjon: hent siste analyse for en samtale ───────────────
create or replace function public.latest_call_analysis(p_call_id uuid)
returns public.call_analyses
language sql stable as $$
  select *
  from public.call_analyses
  where call_id = p_call_id
    and analysis_type = 'single_call'
  order by created_at desc
  limit 1;
$$;

grant execute on function public.latest_call_analysis(uuid) to authenticated;

-- ── 4. View: aggregert oversikt over hva AI sliter med ────────────────
create or replace view public.call_analysis_problem_patterns as
select
  tenant_id,
  jsonb_array_elements(detected_problems) as problem,
  count(*) over (partition by tenant_id, jsonb_array_elements(detected_problems)) as occurrence_count,
  max(created_at) as last_seen
from public.call_analyses
where analysis_type = 'single_call'
  and detected_problems is not null
  and jsonb_array_length(detected_problems) > 0
group by tenant_id, problem, created_at;

grant select on public.call_analysis_problem_patterns to authenticated;

-- ── Done ──────────────────────────────────────────────────────────────
-- Verifiser:
--   select count(*) from public.call_analyses; -- skal være 0 første gang
--   select pg_get_functiondef('public.latest_call_analysis(uuid)'::regprocedure);
