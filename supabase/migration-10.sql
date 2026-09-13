-- MIGRATION 10 — Expenses register. Run once.
create table if not exists public.expenses (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
alter table public.expenses enable row level security;
drop policy if exists exp_all on public.expenses;
create policy exp_all on public.expenses for all to authenticated
  using (is_accounts()) with check (is_accounts());
drop trigger if exists touch_expenses on public.expenses;
create trigger touch_expenses before insert or update on public.expenses
  for each row execute function public.touch_updated_at();
