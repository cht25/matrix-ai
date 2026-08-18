-- =============================================================================
-- MATRIX AI — Promote a user to an admin role
--
-- Usage (run in Supabase SQL editor or via psql):
--   1. Find the user's UUID:  select id, email from auth.users where email = 'you@example.com';
--   2. Replace <USER_UUID> and <ROLE_NAME> below and run.
--
-- Roles: super_admin | security_admin | content_admin | support_admin | auditor
-- =============================================================================

insert into public.admin_role_assignments (user_id, role_id, assigned_by)
select au.id, ar.id, null
from auth.users au
cross join public.admin_roles ar
where au.id = '<USER_UUID>'
  and ar.name = '<ROLE_NAME>'
on conflict (user_id) do update
  set role_id = excluded.role_id;

-- Verify:
-- select p.email, r.name as role from public.admin_role_assignments ra
--   join public.profiles p on p.id = ra.user_id
--   join public.admin_roles r on r.id = ra.role_id;
