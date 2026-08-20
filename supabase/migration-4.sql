-- ============================================================
-- MIGRATION 4 — Projects module + Contractor access rules
-- Run once in Supabase SQL Editor.
-- ============================================================

create or replace function public.is_builder() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select role from profiles where auth_id = auth.uid()) in ('Owner / Super Admin','Engineer'), false) $$;

create or replace function public.is_contractor() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select role from profiles where auth_id = auth.uid()) = 'Contractor', false) $$;

create table if not exists public.projects (
  id text primary key,
  team uuid[] default '{}',
  contractors uuid[] default '{}',
  data jsonb not null,
  updated_at timestamptz default now()
);
create table if not exists public.ptasks (
  id text primary key,
  project_id text,
  assignees uuid[] default '{}',
  data jsonb not null,
  updated_at timestamptz default now()
);

alter table public.projects enable row level security;
alter table public.ptasks enable row level security;

drop policy if exists prj_sel on public.projects;
create policy prj_sel on public.projects for select to authenticated
  using (is_builder() or my_profile() = any(coalesce(team,'{}')) or my_profile() = any(coalesce(contractors,'{}')));
drop policy if exists prj_write on public.projects;
create policy prj_write on public.projects for all to authenticated
  using (is_builder()) with check (is_builder());

drop policy if exists pt_sel on public.ptasks;
create policy pt_sel on public.ptasks for select to authenticated
  using (is_builder()
         or my_profile() = any(coalesce(assignees,'{}'))
         or exists (select 1 from public.projects p where p.id = project_id
                    and (my_profile() = any(coalesce(p.team,'{}')) or my_profile() = any(coalesce(p.contractors,'{}')))));
drop policy if exists pt_ins on public.ptasks;
create policy pt_ins on public.ptasks for insert to authenticated with check (is_builder());
drop policy if exists pt_upd on public.ptasks;
create policy pt_upd on public.ptasks for update to authenticated
  using (is_builder() or my_profile() = any(coalesce(assignees,'{}')))
  with check (is_builder() or my_profile() = any(coalesce(assignees,'{}')));
drop policy if exists pt_del on public.ptasks;
create policy pt_del on public.ptasks for delete to authenticated using (is_builder());

-- Contractors: no access to office tasks, and they can read only their own profile
drop policy if exists tasks_sel on public.tasks;
create policy tasks_sel on public.tasks for select to authenticated
  using (not is_contractor());

drop policy if exists profiles_sel on public.profiles;
create policy profiles_sel on public.profiles for select to authenticated
  using (not is_contractor() or auth_id = auth.uid());
