-- ============================================================
-- MIGRATION 3 — Accounts module (run once in SQL Editor)
-- Bank accounts, receipts & payments, ledger masters.
-- Access: Owner and the Payments head only.
-- ============================================================

create or replace function public.is_accounts() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select role from profiles where auth_id = auth.uid()) in ('Owner / Super Admin','Payments'), false) $$;

create table if not exists public.bank_accounts (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table if not exists public.acct_entries (
  id text primary key,
  account_id text,
  data jsonb not null,
  updated_at timestamptz default now()
);

alter table public.bank_accounts enable row level security;
alter table public.acct_entries enable row level security;

drop policy if exists ba_all on public.bank_accounts;
create policy ba_all on public.bank_accounts for all to authenticated
  using (is_accounts()) with check (is_accounts());

drop policy if exists ae_all on public.acct_entries;
create policy ae_all on public.acct_entries for all to authenticated
  using (is_accounts()) with check (is_accounts());

insert into public.masters (key, items) values
('ledgers','["Rent","Salaries","Vendor payment","Sales advance","Professional fees","EB / utilities"]')
on conflict (key) do nothing;
insert into public.masters (key, items) values
('categories','["Direct expense","Indirect expense","Income","Capital","Transfer"]')
on conflict (key) do nothing;
