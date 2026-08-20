-- ============================================================
-- MIGRATION 6 — mobile number hygiene. Run once.
-- 1) Cleans every stored mobile to bare digits (removes +91,
--    spaces, dashes that were silently blocking registrations).
-- 2) Makes the sign-up gate compare on digits only, so this
--    class of problem can never block anyone again.
-- ============================================================

update public.profiles
set mobile = nullif(right(regexp_replace(mobile, '[^0-9]', '', 'g'), 10), '')
where mobile is not null;

create or replace function public.link_profile_on_signup() returns trigger
language plpgsql security definer set search_path = public as $$
declare m text; n int;
begin
  m := split_part(new.email, '@', 1);
  update profiles
  set auth_id = new.id
  where right(regexp_replace(coalesce(mobile, ''), '[^0-9]', '', 'g'), 10) = m
    and auth_id is null;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'This mobile number is not registered by the Owner';
  end if;
  return new;
end $$;
