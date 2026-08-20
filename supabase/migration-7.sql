-- ============================================================
-- MIGRATION 7 — fix the repeating "Set your PIN" screen. Run once.
-- 1) Lets each person save changes to their own profile using the
--    write method the app uses (upsert), which the old insert rule blocked.
-- 2) Clears the stuck "temporary PIN" flag for everyone.
-- ============================================================

drop policy if exists profiles_ins on public.profiles;
create policy profiles_ins on public.profiles for insert to authenticated
  with check (is_owner() or auth_id = auth.uid());

update public.profiles
set data = jsonb_set(coalesce(data, '{}'::jsonb), '{mustChangePin}', 'false'::jsonb);
