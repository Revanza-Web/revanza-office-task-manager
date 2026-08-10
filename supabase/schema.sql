-- ============================================================
-- REVANZA OFFICE TASK MANAGER — Supabase schema
-- Paste this whole file into Supabase: SQL Editor → New query → Run
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid unique references auth.users(id) on delete set null,
  mobile text unique,
  name text not null,
  role text not null default 'Executive',
  status text not null default 'Active',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

create table public.payroll (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  data jsonb not null default '{}'::jsonb
);

create table public.tasks (
  id text primary key,
  assigned_to uuid references public.profiles(id),
  assigned_by uuid references public.profiles(id),
  status text,
  data jsonb not null,
  updated_at timestamptz default now()
);

create table public.cases (
  id text primary key,
  associate uuid references public.profiles(id),
  data jsonb not null,
  updated_at timestamptz default now()
);

create table public.attendance (
  id text primary key,
  profile_id uuid references public.profiles(id),
  date date not null,
  data jsonb not null,
  unique (profile_id, date)
);

create table public.leaves (
  id text primary key,
  profile_id uuid references public.profiles(id),
  status text default 'Pending',
  data jsonb not null
);

create table public.masters ( key text primary key, items jsonb not null default '[]'::jsonb );
create table public.locations ( id text primary key, data jsonb not null );
create table public.app_settings ( id int primary key default 1, data jsonb not null );

create table public.audit (
  id bigint generated always as identity primary key,
  ts timestamptz default now(),
  by_name text, action text, detail text
);

-- ---------- helper functions ----------
create or replace function public.my_profile() returns uuid
language sql stable security definer set search_path = public as
$$ select id from profiles where auth_id = auth.uid() $$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as
$$ select role from profiles where auth_id = auth.uid() $$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select role from profiles where auth_id = auth.uid()) = 'Owner / Super Admin', false) $$;

-- ---------- link a new sign-up to the roster (blocks unknown numbers) ----------
create or replace function public.link_profile_on_signup() returns trigger
language plpgsql security definer set search_path = public as $$
declare m text; n int;
begin
  m := split_part(new.email, '@', 1);
  update profiles set auth_id = new.id where mobile = m and auth_id is null;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'This mobile number is not registered by the Owner';
  end if;
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.link_profile_on_signup();

-- ---------- guards ----------
create or replace function public.guard_profile_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then
    if new.role is distinct from old.role or new.status is distinct from old.status
       or new.mobile is distinct from old.mobile or new.name is distinct from old.name then
      raise exception 'Only the Owner can change name, role, status or mobile number';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger profiles_guard before update on public.profiles
for each row execute function public.guard_profile_update();

create or replace function public.guard_task_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'Completed' and not is_owner() then
    raise exception 'Completed tasks can only be changed by the Owner';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger tasks_guard before update on public.tasks
for each row execute function public.guard_task_update();

-- ---------- row level security ----------
alter table public.profiles enable row level security;
alter table public.payroll enable row level security;
alter table public.tasks enable row level security;
alter table public.cases enable row level security;
alter table public.attendance enable row level security;
alter table public.leaves enable row level security;
alter table public.masters enable row level security;
alter table public.locations enable row level security;
alter table public.app_settings enable row level security;
alter table public.audit enable row level security;

create policy profiles_sel on public.profiles for select to authenticated using (true);
create policy profiles_ins on public.profiles for insert to authenticated with check (is_owner());
create policy profiles_upd on public.profiles for update to authenticated
  using (is_owner() or auth_id = auth.uid()) with check (is_owner() or auth_id = auth.uid());

create policy payroll_all on public.payroll for all to authenticated
  using (is_owner()) with check (is_owner());

create policy tasks_sel on public.tasks for select to authenticated using (true);
create policy tasks_ins on public.tasks for insert to authenticated with check (true);
create policy tasks_upd on public.tasks for update to authenticated
  using (is_owner() or assigned_to = my_profile() or assigned_by = my_profile())
  with check (is_owner() or assigned_to = my_profile() or assigned_by = my_profile());

create policy cases_all on public.cases for all to authenticated
  using (is_owner() or my_role() = 'Legal Associate')
  with check (is_owner() or my_role() = 'Legal Associate');

create policy att_sel on public.attendance for select to authenticated
  using (is_owner() or profile_id = my_profile());
create policy att_ins on public.attendance for insert to authenticated
  with check (profile_id = my_profile());
create policy att_upd on public.attendance for update to authenticated
  using (is_owner() or profile_id = my_profile())
  with check (is_owner() or profile_id = my_profile());

create policy leaves_sel on public.leaves for select to authenticated
  using (is_owner() or profile_id = my_profile());
create policy leaves_ins on public.leaves for insert to authenticated
  with check (profile_id = my_profile());
create policy leaves_upd on public.leaves for update to authenticated
  using (is_owner() or (profile_id = my_profile() and status = 'Pending'))
  with check (is_owner() or profile_id = my_profile());

create policy masters_sel on public.masters for select to authenticated using (true);
create policy masters_ins on public.masters for insert to authenticated with check (true);
create policy masters_upd on public.masters for update to authenticated using (true) with check (true);

create policy loc_sel on public.locations for select to authenticated using (true);
create policy loc_all on public.locations for all to authenticated using (is_owner()) with check (is_owner());

create policy set_sel on public.app_settings for select to authenticated using (true);
create policy set_all on public.app_settings for all to authenticated using (is_owner()) with check (is_owner());

create policy audit_ins on public.audit for insert to authenticated with check (true);
create policy audit_sel on public.audit for select to authenticated using (is_owner());

-- ---------- seed: the 15 Revanza staff ----------
insert into public.profiles (mobile, name, role, status, data) values
('9841344444','Sushil','Owner / Super Admin','Active','{"empCode":"EMP01","dept":"Management","designation":"Owner / Super Admin","email":"md@revanza.in","manager":"—"}'),
(null,'Bala','Engineer','Active','{"empCode":"EMP02","dept":"Engineering","manager":"Sushil"}'),
(null,'Govind','Drawings','Active','{"empCode":"EMP03","dept":"Drawings","manager":"Sushil"}'),
(null,'Mariya','Executive','Active','{"empCode":"EMP04","dept":"Operations","manager":"Sushil"}'),
(null,'Mrithula','Legal Associate','Active','{"empCode":"EMP05","dept":"Legal","email":"legal@revanza.in","manager":"Sushil"}'),
(null,'Prathik','Legal Associate','Active','{"empCode":"EMP06","dept":"Legal","email":"legal3@revanza.in","manager":"Sushil"}'),
(null,'Praveen','Legal Associate','Active','{"empCode":"EMP07","dept":"Legal","email":"legal@oylo.in","manager":"Sushil"}'),
('9514300000','Prem','Payments','Active','{"empCode":"EMP08","dept":"Accounts","email":"info@thefuel.in","manager":"Sushil"}'),
(null,'Rajashekar','Engineer','Active','{"empCode":"EMP09","dept":"Engineering","manager":"Sushil"}'),
(null,'Senthil','Executive','Active','{"empCode":"EMP10","dept":"Operations","manager":"Sushil"}'),
(null,'Shivani','Legal Associate','Active','{"empCode":"EMP11","dept":"Legal","email":"legal2@revanza.in","manager":"Sushil"}'),
(null,'Sneka','Admin','Active','{"empCode":"EMP12","dept":"Administration","manager":"Sushil"}'),
(null,'Sontha','Admin','Active','{"empCode":"EMP13","dept":"Administration","manager":"Sushil"}'),
('9841498198','Vijay','Accounts','Active','{"empCode":"EMP14","dept":"Accounts","email":"vijay@thefuel.in","manager":"Sushil"}'),
(null,'Vinoth','Executive','Active','{"empCode":"EMP15","dept":"Operations","manager":"Sushil"}');

insert into public.masters (key, items) values
('entities','["Revanza Estates","Revanza Constructions","The Fuel"]'),
('courts','["Madras High Court","City Civil Court, Chennai","District Consumer Commission, Chennai"]'),
('judges','[]'),
('counsels','[]'),
('sections','["Art. 226","Or.39 R.1 \u0026 2 CPC","S.35 CP Act"]'),
('caseStages','[]'),
('nextActions','["Appearance","Briefing","Conference","Discussion"]'),
('leaveReasons','["Family function","Medical","Personal work","Travel"]');

insert into public.locations (id, data) values
('LOC1','{"id":"LOC1","name":"Head Office — Chennai","lat":13.0827,"lng":80.2707,"radiusM":250}');

insert into public.app_settings (id, data) values
(1,'{"morningDue":"10:30","ownerEmail":"md@revanza.in"}');
