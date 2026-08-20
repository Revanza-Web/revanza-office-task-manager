-- ============================================================
-- MIGRATION 2 — run this once in Supabase SQL Editor if you set
-- the database up with the original schema.sql.
-- Adds: group tasks, notifications, case types master.
-- ============================================================

-- group tasks: allow every allocated member to update the task
alter table public.tasks add column if not exists assignees uuid[] default '{}';

drop policy if exists tasks_upd on public.tasks;
create policy tasks_upd on public.tasks for update to authenticated
  using (is_owner() or assigned_to = my_profile() or assigned_by = my_profile()
         or my_profile() = any(coalesce(assignees, '{}')))
  with check (is_owner() or assigned_to = my_profile() or assigned_by = my_profile()
         or my_profile() = any(coalesce(assignees, '{}')));

-- notifications
create table if not exists public.notifications (
  id text primary key,
  profile_id uuid references public.profiles(id) on delete cascade,
  ts timestamptz default now(),
  text text,
  kind text,
  ref jsonb,
  read boolean default false
);
alter table public.notifications enable row level security;
drop policy if exists notif_sel on public.notifications;
drop policy if exists notif_ins on public.notifications;
drop policy if exists notif_upd on public.notifications;
create policy notif_sel on public.notifications for select to authenticated using (profile_id = my_profile());
create policy notif_ins on public.notifications for insert to authenticated with check (true);
create policy notif_upd on public.notifications for update to authenticated
  using (profile_id = my_profile()) with check (profile_id = my_profile());

-- self-learning case types
insert into public.masters (key, items)
values ('caseTypes', '["Suit for injunction","Writ petition","Consumer complaint","Arbitration","Criminal complaint","Appeal"]')
on conflict (key) do nothing;
