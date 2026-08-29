-- ============================================================
-- MIGRATION 9 — v3.0: file storage + incremental sync. Run once.
-- 1) Creates the "rotm" storage bucket where photos and documents
--    now live (instead of inside database rows).
-- 2) Keeps updated_at fresh on every change, which lets the app
--    fetch only what changed instead of everything, every time.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('rotm', 'rotm', true)
on conflict (id) do nothing;

drop policy if exists "rotm upload" on storage.objects;
create policy "rotm upload" on storage.objects
  for insert to authenticated with check (bucket_id = 'rotm');

drop policy if exists "rotm read" on storage.objects;
create policy "rotm read" on storage.objects
  for select to public using (bucket_id = 'rotm');

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['profiles','payroll','tasks','cases','attendance','leaves',
    'masters','locations','app_settings','audit','notifications',
    'bank_accounts','acct_entries','projects','ptasks','companies']
  loop
    begin
      execute format('alter table public.%I add column if not exists updated_at timestamptz default now()', t);
      execute format('drop trigger if exists touch_%I on public.%I', t, t);
      execute format('create trigger touch_%I before insert or update on public.%I for each row execute function public.touch_updated_at()', t, t);
    exception when undefined_table then null;
    end;
  end loop;
end $$;
