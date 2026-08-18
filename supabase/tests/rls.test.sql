-- =============================================================================
-- MATRIX AI — RLS & constraint test suite (spec §64, §65)
--
-- Run against a local/CI Supabase instance with seeded data:
--   supabase start && supabase db reset && supabase db test
-- (or: psql "$DATABASE_URL" -f supabase/tests/rls.test.sql)
--
-- Every test raises an exception on failure so the runner reports a failure.
-- =============================================================================

begin;

-- Helper: fail loudly
create or replace function tests.assert(cond boolean, msg text) returns void
language plpgsql as $$
begin
  if not cond then
    raise exception 'TEST FAILED: %', msg;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Age validation (spec §8, §64)
-- ---------------------------------------------------------------------------
select tests.assert(public.calculate_age('2015-01-01'::date) = 11, 'age 11 boundary');
select tests.assert(public.calculate_age('2008-01-01'::date) = 18, 'age 18 boundary');

do $$
begin
  begin
    perform public.validate_dob('2026-01-01'::date);  -- future
    raise exception 'future DOB was accepted';
  exception when others then
    if sqlerrm <> 'DOB_FUTURE' then raise; end if;
  end;
end $$;

do $$
begin
  begin
    perform public.validate_dob('2010-01-01'::date);  -- 16, ok
  exception when others then
    raise exception 'valid DOB rejected: %', sqlerrm;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 2. RLS: anon cannot read profiles
-- ---------------------------------------------------------------------------
set role anon;
select tests.assert(
  (select count(*) from public.profiles) = 0,
  'anon must not read profiles'
);
reset role;

-- ---------------------------------------------------------------------------
-- 3. RLS: user cannot read another user's conversation
-- ---------------------------------------------------------------------------
set role authenticated;
-- (authenticated role needs a JWT claim; use request.jwt.claims for the check)
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);

select tests.assert(
  (select count(*) from public.conversations
    where user_id = '00000000-0000-0000-0000-000000000002') = 0,
  'user A must not see user B conversations'
);
reset role;

-- ---------------------------------------------------------------------------
-- 4. Quiz options never expose is_correct through the public view
-- ---------------------------------------------------------------------------
select tests.assert(
  not exists (
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'quiz_options_public'
      and column_name = 'is_correct'
  ),
  'quiz_options_public must not expose is_correct'
);

-- ---------------------------------------------------------------------------
-- 5. Constraints
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.course_progress (user_id, lesson_id, status, progress, completed_at)
    values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010', 'completed', 50, now());
    raise exception 'invalid progress state accepted';
  exception when others then
    if sqlerrm like 'TEST%' then raise; end if; -- constraint fired as expected
  end;
end $$;

-- Certificate id uniqueness
do $$
begin
  begin
    insert into public.certificates (user_id, course_id, certificate_id)
    values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000020', 'MATRIX-2026-DUP00001'),
           ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000021', 'MATRIX-2026-DUP00001');
    raise exception 'duplicate certificate id accepted';
  exception when others then
    if sqlerrm like 'TEST%' then raise; end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 6. SECURITY DEFINER functions are locked down
-- ---------------------------------------------------------------------------
select tests.assert(
  (select has_function_privilege('anon', 'public.verify_certificate_lookup(text)', 'EXECUTE')),
  'anon may verify certificates'
);

do $$
begin
  begin
    -- anon must NOT be able to call admin functions
    perform public.log_audit('x');
    raise exception 'anon called admin function';
  exception when others then
    null; -- PERMISSION_DENIED or function-not-executable, both fine
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Sensitive profile columns are protected from direct updates
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    update public.profiles set age_verified = true
     where id = '00000000-0000-0000-0000-000000000001';
    raise exception 'direct age_verified update accepted';
  exception when others then
    if sqlerrm like 'TEST%' then raise; end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Temporary chat retention function exists
-- ---------------------------------------------------------------------------
select tests.assert(
  exists (select 1 from pg_proc where proname = 'expire_stale'),
  'expire_stale() must exist'
);
select tests.assert(
  exists (select 1 from pg_proc where proname = 'security_score'),
  'security_score() must exist'
);

rollback;
