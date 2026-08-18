-- =============================================================================
-- MATRIX AI — 0006: Database functions, triggers, grants and Row Level Security
-- =============================================================================

-- =============================================================================
-- 1. HELPERS
-- =============================================================================

create or replace function public.calculate_age(p_dob date)
returns integer
language sql
immutable
as $$
  select date_part('year', age(current_date, p_dob))::int;
$$;

-- Registration only succeeds when 11 <= age <= 17. Rejects invalid/future DOBs.
create or replace function public.validate_dob(p_dob date)
returns void
language plpgsql
stable
as $$
declare v_age integer;
begin
  if p_dob is null then
    raise exception 'DOB_MISSING';
  end if;
  if p_dob > current_date then
    raise exception 'DOB_FUTURE';
  end if;
  v_age := public.calculate_age(p_dob);
  if v_age < 11 then
    raise exception 'DOB_TOO_YOUNG';
  end if;
  if v_age > 17 then
    raise exception 'DOB_TOO_OLD';
  end if;
end $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- =============================================================================
-- 2. AUTH → PROFILE PROVISIONING
-- =============================================================================

-- Creates the app profile (and defaults) when a user signs up, with
-- server-side DOB validation. OAuth users may have a NULL dob — they must
-- complete onboarding (public.complete_profile) before using the app.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_dob date;
  v_provider text;
begin
  v_dob := nullif(new.raw_user_meta_data ->> 'dob', '')::date;
  if v_dob is not null then
    perform public.validate_dob(v_dob);
  end if;

  insert into public.profiles (id, full_name, email, date_of_birth)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), ''),
    coalesce(new.email, ''),
    v_dob
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = case when profiles.full_name = '' then excluded.full_name else profiles.full_name end;

  insert into public.user_security_settings (user_id) values (new.id)
  on conflict (user_id) do nothing;

  v_provider := coalesce(new.app_metadata ->> 'provider', 'email');
  if v_provider <> 'email' then
    insert into public.oauth_profiles (user_id, provider, provider_user_id)
    values (new.id, v_provider, coalesce(new.raw_user_meta_data ->> 'provider_id', ''))
    on conflict (provider, provider_user_id) do nothing;
  end if;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- 3. PROFILE PROTECTION
-- =============================================================================

-- age_verified / age_verified_at / date_of_birth can ONLY be changed through
-- SECURITY DEFINER functions (complete_profile, review_identity_verification).
create or replace function public.protect_profile_sensitive_columns()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.profile_override', true), '') <> 'true' then
    if new.date_of_birth is distinct from old.date_of_birth
       or new.age_verified is distinct from old.age_verified
       or new.age_verified_at is distinct from old.age_verified_at
    then
      raise exception 'PROFILE_SENSITIVE_COLUMN_BLOCKED';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists protect_profile_sensitive_columns on public.profiles;
create trigger protect_profile_sensitive_columns
  before update on public.profiles
  for each row execute function public.protect_profile_sensitive_columns();

-- =============================================================================
-- 4. ONBOARDING (DOB for OAuth users, school, country, consent workflow)
-- =============================================================================

create or replace function public.complete_profile(
  p_dob date,
  p_full_name text default '',
  p_school_name text default '',
  p_class_grade text default '',
  p_country text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_age integer;
  v_consent_required boolean;
  v_min_age integer;
  v_was_oauth boolean;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;

  perform public.validate_dob(p_dob);
  v_age := public.calculate_age(p_dob);

  v_consent_required := true;
  v_min_age := 13;
  if p_country is not null then
    select consent_required, consent_min_age into v_consent_required, v_min_age
    from public.countries where id = p_country;
    if not found then
      v_consent_required := true; v_min_age := 13;
    end if;
  end if;

  perform set_config('app.profile_override', 'true', true);
  update public.profiles
     set date_of_birth = p_dob,
         age_verified = false,
         age_verified_at = null,
         full_name = case when p_full_name = '' then full_name else p_full_name end,
         school_name = case when p_school_name = '' then school_name else p_school_name end,
         class_grade = case when p_class_grade = '' then class_grade else p_class_grade end,
         country = coalesce(p_country, country)
   where id = v_user;
  perform set_config('app.profile_override', 'false', true);

  -- Consent workflow: configurable per country. Self-consent auto-approves
  -- when the user is at/above the country consent age; otherwise a guardian
  -- consent is required (pending review).
  insert into public.guardian_consents (user_id, status, consent_method)
  values (
    v_user,
    case when v_age >= v_min_age and v_consent_required then 'approved'
         when not v_consent_required then 'approved'
         else 'pending' end,
    case when v_age >= v_min_age and v_consent_required then 'self'
         else 'guardian' end
  )
  on conflict (user_id) do update
    set updated_at = now();

  if v_age >= v_min_age and v_consent_required then
    update public.guardian_consents
       set status = 'approved', consented_at = now()
     where user_id = v_user and status = 'pending';
  end if;

  return jsonb_build_object(
    'age', v_age,
    'consent_required', v_consent_required,
    'consent_status', (select status from public.guardian_consents where user_id = v_user),
    'identity_verification_required', true
  );
end $$;

-- Guardian consent submission (for under-consent-age users)
create or replace function public.submit_guardian_consent(
  p_guardian_name text,
  p_guardian_email text,
  p_relationship text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if length(trim(p_guardian_name)) < 2 or position('@' in p_guardian_email) = 0 then
    raise exception 'GUARDIAN_DETAILS_INVALID';
  end if;
  update public.guardian_consents
     set guardian_name = trim(p_guardian_name),
         guardian_email = lower(trim(p_guardian_email)),
         guardian_relationship = trim(p_relationship),
         status = 'pending',
         updated_at = now()
   where user_id = v_user;
  return found;
end $$;

-- =============================================================================
-- 5. IDENTITY / CONSENT REVIEW (admin, RBAC-gated)
-- =============================================================================

create or replace function public.review_identity_verification(
  p_verification_id uuid,
  p_approve boolean,
  p_reason text default ''
) returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user uuid;
  v_reviewer uuid := auth.uid();
begin
  if not public.has_permission('verification.review') then
    raise exception 'PERMISSION_DENIED';
  end if;
  select user_id into v_user from public.identity_verifications where id = p_verification_id;
  if v_user is null then raise exception 'NOT_FOUND'; end if;

  if p_approve then
    update public.identity_verifications
       set verification_status = 'approved',
           reviewer_id = v_reviewer,
           verified_at = now(),
           updated_at = now()
     where id = p_verification_id;

    perform set_config('app.profile_override', 'true', true);
    update public.profiles
       set age_verified = true,
           age_verified_at = now()
     where id = v_user;
    perform set_config('app.profile_override', 'false', true);

    insert into public.notifications (user_id, type, title, body)
    values (v_user, 'security', 'Identity verified',
            'Your age verification was approved. Welcome to MATRIX AI!');
    insert into public.security_events (user_id, event_type, metadata)
    values (v_user, 'identity_verified', jsonb_build_object('by', v_reviewer));
  else
    update public.identity_verifications
       set verification_status = 'rejected',
           reviewer_id = v_reviewer,
           rejection_reason = p_reason,
           updated_at = now()
     where id = p_verification_id;
    insert into public.notifications (user_id, type, title, body)
    values (v_user, 'security', 'Identity verification needs attention',
            'Please re-submit your age verification document.');
  end if;

  perform public.log_audit('identity_verification_' || case when p_approve then 'approved' else 'rejected' end,
                           'identity_verification', p_verification_id::text, p_reason);
  return true;
end $$;

create or replace function public.review_guardian_consent(
  p_user_id uuid,
  p_approve boolean,
  p_reason text default ''
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_reviewer uuid := auth.uid();
begin
  if not public.has_permission('consent.review') then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_approve then
    update public.guardian_consents
       set status = 'approved', consented_at = now(), updated_at = now()
     where user_id = p_user_id;
    insert into public.security_events (user_id, event_type, metadata)
    values (p_user_id, 'consent_approved', jsonb_build_object('by', v_reviewer));
    insert into public.notifications (user_id, type, title, body)
    values (p_user_id, 'security', 'Guardian consent approved',
            'A guardian approved your MATRIX AI account. Happy learning!');
  else
    update public.guardian_consents
       set status = 'revoked', revoked_at = now(), updated_at = now()
     where user_id = p_user_id;
  end if;
  perform public.log_audit('guardian_consent_' || case when p_approve then 'approved' else 'revoked' end,
                           'guardian_consents', p_user_id::text, p_reason);
  return true;
end $$;

-- =============================================================================
-- 6. SECURITY EVENTS & SESSIONS
-- =============================================================================

create or replace function public.record_security_event(
  p_event_type text,
  p_metadata jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_event_type not in ('login','logout','password_changed','password_reset',
                          'email_changed','mfa_enabled','mfa_disabled','new_device',
                          'suspicious_activity') then
    raise exception 'EVENT_TYPE_FORBIDDEN';
  end if;
  insert into public.security_events (user_id, event_type, metadata)
  values (v_user, p_event_type, coalesce(p_metadata, '{}'::jsonb));
  return true;
end $$;

create or replace function public.revoke_session(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  update public.user_sessions
     set revoked_at = now()
   where id = p_session_id and user_id = v_user;
  return found;
end $$;

-- =============================================================================
-- 7. ADMIN RBAC
-- =============================================================================

create or replace function public.has_permission(p_permission text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_role_assignments ra
    join public.admin_role_permissions rp on rp.role_id = ra.role_id
    join public.admin_permissions p on p.id = rp.permission_id
    where ra.user_id = auth.uid() and p.code = p_permission
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.admin_role_assignments where user_id = auth.uid()
  );
$$;

create or replace function public.log_audit(
  p_action text,
  p_target_type text default '',
  p_target_id text default '',
  p_reason text default '',
  p_metadata jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'PERMISSION_DENIED';
  end if;
  insert into public.audit_logs (actor_id, action, target_type, target_id, reason, metadata)
  values (auth.uid(), p_action, p_target_type, p_target_id, p_reason, coalesce(p_metadata, '{}'::jsonb));
  return true;
end $$;

create or replace function public.admin_list_users()
returns table (
  id uuid, email text, full_name text, created_at timestamptz,
  last_sign_in_at timestamptz, age_verified boolean, country text,
  consent_status text, identity_status text
)
language plpgsql
security definer
stable
set search_path = public, auth
as $$
begin
  if not public.has_permission('users.view') then
    raise exception 'PERMISSION_DENIED';
  end if;
  return query
    select p.id, p.email, p.full_name, p.created_at,
           au.last_sign_in_at, p.age_verified, p.country,
           coalesce(gc.status, 'none'),
           coalesce((select verification_status from public.identity_verifications iv
                     where iv.user_id = p.id order by iv.created_at desc limit 1), 'none')
    from public.profiles p
    left join auth.users au on au.id = p.id
    left join public.guardian_consents gc on gc.user_id = p.id
    order by p.created_at desc;
end $$;

-- =============================================================================
-- 8. PRIVILEGED DATA ACCESS (admin → user conversations, time-limited + audited)
-- =============================================================================

create or replace function public.request_admin_access(
  p_target_user_id uuid,
  p_scope text default 'conversations',
  p_reason text default '',
  p_duration_hours integer default 24
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_grant uuid;
begin
  if not public.has_permission('privacy.access') then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_duration_hours < 1 or p_duration_hours > 168 then
    raise exception 'DURATION_INVALID';
  end if;
  insert into public.admin_access_grants
    (requester_id, target_user_id, scope, reason, expires_at)
  values
    (auth.uid(), p_target_user_id, p_scope, trim(p_reason), now() + (p_duration_hours || ' hours')::interval)
  returning id into v_grant;
  perform public.log_audit('admin_access_requested', 'user', p_target_user_id::text, p_reason,
                           jsonb_build_object('grant_id', v_grant, 'scope', p_scope));
  return v_grant;
end $$;

create or replace function public.admin_view_conversation(
  p_grant_id uuid,
  p_conversation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target uuid;
  v_messages jsonb;
begin
  if not public.has_permission('privacy.access') then
    raise exception 'PERMISSION_DENIED';
  end if;
  select target_user_id into v_target
    from public.admin_access_grants
   where id = p_grant_id and status = 'active' and expires_at > now() and scope = 'conversations';
  if v_target is null then raise exception 'GRANT_INVALID_OR_EXPIRED'; end if;

  select user_id into v_target from public.conversations where id = p_conversation_id;
  if v_target is null then raise exception 'NOT_FOUND'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('role', m.role, 'content', m.content, 'created_at', m.created_at) order by m.created_at), '[]'::jsonb)
    into v_messages
    from public.conversation_messages m
    where m.conversation_id = p_conversation_id;

  perform public.log_audit('admin_conversation_viewed', 'conversation', p_conversation_id::text,
                           (select reason from public.admin_access_grants where id = p_grant_id),
                           jsonb_build_object('grant_id', p_grant_id));
  return v_messages;
end $$;

create or replace function public.admin_list_conversations(p_grant_id uuid)
returns table (id uuid, title text, created_at timestamptz, updated_at timestamptz, is_temporary boolean)
language plpgsql
security definer
stable
set search_path = public
as $$
declare v_target uuid;
begin
  if not public.has_permission('privacy.access') then
    raise exception 'PERMISSION_DENIED';
  end if;
  select target_user_id into v_target
    from public.admin_access_grants
   where id = p_grant_id and status = 'active' and expires_at > now() and scope = 'conversations';
  if v_target is null then raise exception 'GRANT_INVALID_OR_EXPIRED'; end if;
  return query
    select c.id, c.title, c.created_at, c.updated_at, c.is_temporary
    from public.conversations c
    where c.user_id = v_target and c.deleted_at is null
    order by c.updated_at desc;
end $$;

-- =============================================================================
-- 9. LEARNING
-- =============================================================================

-- Progress is managed server-side; values are constrained by the table checks.
create or replace function public.update_course_progress(
  p_lesson_id uuid,
  p_status text default 'started'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_status not in ('started','completed') then raise exception 'STATUS_INVALID'; end if;
  if not exists (select 1 from public.lessons l
                 join public.course_modules m on m.id = l.module_id
                 join public.courses c on c.id = m.course_id
                 where l.id = p_lesson_id and c.status = 'published') then
    raise exception 'LESSON_NOT_FOUND';
  end if;

  insert into public.course_progress (user_id, lesson_id, status, progress, completed_at)
  values (
    v_user, p_lesson_id,
    case when p_status = 'completed' then 'completed' else 'started' end,
    case when p_status = 'completed' then 100 else 10 end,
    case when p_status = 'completed' then now() else null end
  )
  on conflict (user_id, lesson_id) do update
    set status = case when p_status = 'completed' then 'completed' else course_progress.status end,
        progress = case when p_status = 'completed' then 100 else greatest(course_progress.progress, 10) end,
        completed_at = case when p_status = 'completed' then coalesce(course_progress.completed_at, now()) else course_progress.completed_at end,
        updated_at = now();

  return jsonb_build_object('ok', true);
end $$;

-- Scores are computed in the database — clients can never fake a result.
create or replace function public.submit_quiz_attempt(
  p_quiz_id uuid,
  p_answers jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_total integer;
  v_correct integer := 0;
  v_percent numeric(5,2);
  v_passed boolean;
  v_max_attempts integer;
  v_attempts integer;
  v_answer record;
  v_q uuid;
  v_opt uuid;
  v_correct_opt uuid;
  v_result jsonb := '[]'::jsonb;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;

  select max_attempts into v_max_attempts from public.quizzes where id = p_quiz_id;
  if not found then raise exception 'QUIZ_NOT_FOUND'; end if;

  if v_max_attempts > 0 then
    select count(*) into v_attempts from public.quiz_attempts
     where user_id = v_user and quiz_id = p_quiz_id;
    if v_attempts >= v_max_attempts then raise exception 'ATTEMPT_LIMIT_REACHED'; end if;
  end if;

  select count(*) into v_total from public.quiz_questions where quiz_id = p_quiz_id;
  if v_total = 0 then raise exception 'QUIZ_EMPTY'; end if;

  for v_answer in select * from jsonb_array_elements(p_answers) with ordinality as t(a, n)
  loop
    v_q := (v_answer.a ->> 'question_id')::uuid;
    v_opt := (v_answer.a ->> 'option_id')::uuid;
    select id into v_correct_opt from public.quiz_options
     where question_id = v_q and is_correct = true limit 1;
    if v_correct_opt is not null and v_correct_opt = v_opt then
      v_correct := v_correct + 1;
    end if;
    v_result := v_result || jsonb_build_object(
      'question_id', v_q,
      'selected_option_id', v_opt,
      'correct_option_id', v_correct_opt,
      'correct', v_correct_opt = v_opt
    );
  end loop;

  v_percent := round((v_correct::numeric / v_total::numeric) * 100, 2);
  select (v_percent >= pass_percent) into v_passed from public.quizzes where id = p_quiz_id;

  insert into public.quiz_attempts (user_id, quiz_id, score_percent, passed, answers)
  values (v_user, p_quiz_id, v_percent, v_passed, v_result)
  returning id into v_opt; -- reuse as attempt id

  return jsonb_build_object(
    'attempt_id', v_opt,
    'score_percent', v_percent,
    'passed', v_passed,
    'correct', v_correct,
    'total', v_total,
    'results', v_result
  );
end $$;

create or replace function public.check_certificate_eligibility(
  p_user_id uuid,
  p_course_id uuid
) returns table (eligible boolean, reason text)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_lessons integer;
  v_done integer;
  v_quizzes integer;
  v_passed_quizzes integer;
begin
  if not exists (select 1 from public.courses where id = p_course_id and status = 'published') then
    return query select false, 'Course not found or not published';
    return;
  end if;

  select count(*) into v_lessons
    from public.lessons l
    join public.course_modules m on m.id = l.module_id
   where m.course_id = p_course_id;

  select count(*) into v_done
    from public.course_progress cp
    join public.lessons l on l.id = cp.lesson_id
    join public.course_modules m on m.id = l.module_id
   where m.course_id = p_course_id and cp.user_id = p_user_id and cp.status = 'completed';

  if v_done < v_lessons then
    return query select false, format('Complete all lessons (%s of %s done)', v_done, v_lessons);
    return;
  end if;

  select count(*) into v_quizzes
    from public.quizzes q
    join public.course_modules m on m.id = q.module_id
   where m.course_id = p_course_id;

  select count(distinct q.id) into v_passed_quizzes
    from public.quiz_attempts qa
    join public.quizzes q on q.id = qa.quiz_id
    join public.course_modules m on m.id = q.module_id
   where m.course_id = p_course_id and qa.user_id = p_user_id and qa.passed = true;

  if v_quizzes > 0 and v_passed_quizzes < v_quizzes then
    return query select false, format('Pass every quiz (%s of %s passed)', v_passed_quizzes, v_quizzes);
    return;
  end if;

  if exists (select 1 from public.certificates where user_id = p_user_id and course_id = p_course_id) then
    return query select false, 'Certificate already issued for this course';
    return;
  end if;

  return query select true, 'Eligible';
end $$;

create or replace function public.issue_certificate(p_course_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_eligible boolean;
  v_reason text;
  v_cert_id text;
  v_course_title text;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;

  select eligible, reason into v_eligible, v_reason
    from public.check_certificate_eligibility(v_user, p_course_id);
  if not v_eligible then
    raise exception 'NOT_ELIGIBLE: %', v_reason;
  end if;

  v_cert_id := 'MATRIX-' || to_char(now(), 'YYYY') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.certificates (user_id, course_id, certificate_id)
  values (v_user, p_course_id, v_cert_id);

  select title into v_course_title from public.courses where id = p_course_id;
  insert into public.notifications (user_id, type, title, body, link)
  values (v_user, 'certificate', 'Certificate earned!',
          'You completed "' || v_course_title || '" and earned a certificate.',
          '/certificate');

  return jsonb_build_object('certificate_id', v_cert_id, 'course', v_course_title);
end $$;

-- Public verification — returns ONLY public-safe fields (spec §31).
create or replace function public.verify_certificate_lookup(p_certificate_id text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare v_row jsonb;
begin
  select jsonb_build_object(
    'valid', true,
    'certificate_id', c.certificate_id,
    'course', co.title,
    'display_name', p.full_name,
    'issued_at', c.issued_at,
    'issued_by', 'MATRIX AI — THAMJJ13.TOP White Hat Team',
    'verification_status', c.verification_status
  ) into v_row
    from public.certificates c
    join public.courses co on co.id = c.course_id
    join public.profiles p on p.id = c.user_id
   where c.certificate_id = p_certificate_id;

  if v_row is null then
    return jsonb_build_object('valid', false, 'certificate_id', p_certificate_id);
  end if;

  insert into public.certificate_verification (certificate_id, ip_hash)
  values (p_certificate_id, encode(sha256(coalesce(current_setting('request.headers', true), '')), 'hex'));

  return v_row;
end $$;

-- =============================================================================
-- 10. RAG (PostgreSQL full-text search; pgvector-ready)
-- =============================================================================

create or replace function public.rag_search(p_query text, p_limit integer default 5)
returns table (title text, content text, source_type text, trust_level text, rank real)
language plpgsql
stable
set search_path = public
as $$
declare v_q tsquery := websearch_to_tsquery('simple', p_query);
begin
  if v_q is null then return; end if;
  return query
    select t.title, t.content, t.source_type, t.trust_level, t.rank
    from (
      select d.title, d.content, d.source_type, d.trust_level,
             ts_rank(d.search_vector, v_q) as rank
        from public.document_chunks d
       where d.search_vector @@ v_q
         and d.trust_level in ('trusted_official', 'trusted_internal')
      union all
      select sa.title,
             sa.description || ' ' || sa.warning_signs || ' ' || sa.prevention,
             'scam_article', sa.trust_level,
             ts_rank(to_tsvector('simple', sa.title || ' ' || sa.description || ' ' || sa.warning_signs || ' ' || sa.prevention), v_q) as rank
        from public.scam_articles sa
       where sa.status = 'active'
         and to_tsvector('simple', sa.title || ' ' || sa.description || ' ' || sa.warning_signs || ' ' || sa.prevention) @@ v_q
      union all
      select l.title, l.body, 'lesson', 'trusted_internal',
             ts_rank(to_tsvector('simple', l.title || ' ' || l.body), v_q) as rank
        from public.lessons l
        join public.course_modules m on m.id = l.module_id
        join public.courses c on c.id = m.course_id
       where c.status = 'published'
         and to_tsvector('simple', l.title || ' ' || l.body) @@ v_q
      union all
      select rr.organization, rr.description || ' ' || rr.official_url,
             'reporting_resource', 'trusted_official',
             ts_rank(to_tsvector('simple', rr.organization || ' ' || rr.description), v_q) as rank
        from public.reporting_resources rr
       where rr.status = 'active'
         and to_tsvector('simple', rr.organization || ' ' || rr.description) @@ v_q
    ) t
    order by t.rank desc
    limit p_limit;
end $$;

-- =============================================================================
-- 11. SECURITY SCORE (server-side; UI only displays the result)
-- =============================================================================

create or replace function public.security_score()
returns integer
language plpgsql
security definer
stable
set search_path = public, auth
as $$
declare
  v_user uuid := auth.uid();
  v_score integer := 40;
  v_has_mfa boolean;
  v_email_verified boolean;
  v_identity_verified boolean;
  v_lessons_done integer;
  v_certificates integer;
begin
  if v_user is null then return 0; end if;

  select exists (
    select 1 from auth.mfa_factors
    where user_id = v_user and status = 'verified' and factor_type = 'totp'
  ) into v_has_mfa;
  select email_confirmed_at is not null into v_email_verified
    from auth.users where id = v_user;
  select age_verified into v_identity_verified
    from public.profiles where id = v_user;

  if v_has_mfa then v_score := v_score + 20; end if;
  if v_email_verified then v_score := v_score + 10; end if;
  if v_identity_verified then v_score := v_score + 10; end if;

  select count(*) into v_lessons_done from public.course_progress
   where user_id = v_user and status = 'completed';
  v_score := v_score + least(10, v_lessons_done);

  select count(*) into v_certificates from public.certificates where user_id = v_user;
  v_score := v_score + least(10, v_certificates * 5);

  return least(100, v_score);
end $$;

-- =============================================================================
-- 12. RETENTION / CLEANUP
-- =============================================================================

create or replace function public.expire_stale()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_deleted integer := 0;
begin
  -- Temporary chats: short retention (24h) — hard delete, never archived.
  delete from public.conversations
   where is_temporary = true and created_at < now() - interval '24 hours';
  get diagnostics v_deleted = row_count;

  -- Soft-deleted conversations: permanent removal after 90 days.
  delete from public.conversations
   where deleted_at is not null and deleted_at < now() - interval '90 days';

  -- Pending consents that were never completed expire.
  update public.guardian_consents
     set status = 'expired', updated_at = now()
   where status = 'pending' and created_at < now() - interval '30 days';

  -- Time-limited admin access grants expire.
  update public.admin_access_grants
     set status = 'expired'
   where status = 'active' and expires_at < now();

  -- Verification log retention: 1 year.
  delete from public.certificate_verification
   where verified_at < now() - interval '1 year';

  return v_deleted;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('matrix-ai-retention', '0 3 * * *', 'select public.expire_stale()');
  end if;
exception when others then null;
end $$;

-- =============================================================================
-- 13. MESSAGE / REPORT INSERT GUARDS
-- =============================================================================

-- Client apps may only insert role='user' messages. 'assistant' is written by
-- the server-side AI gateway (service role). 'system' is never app-written.
create or replace function public.conversation_message_guard()
returns trigger
language plpgsql
as $$
declare v_jwt_role text;
begin
  v_jwt_role := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');
  if new.role = 'system' then
    raise exception 'SYSTEM_MESSAGES_FORBIDDEN';
  end if;
  if new.role = 'assistant' and v_jwt_role <> 'service_role' then
    raise exception 'ASSISTANT_INSERT_FORBIDDEN';
  end if;
  return new;
end $$;

drop trigger if exists conversation_message_guard on public.conversation_messages;
create trigger conversation_message_guard
  before insert on public.conversation_messages
  for each row execute function public.conversation_message_guard();

-- Conversations are immutable once created (ownership / temp flag).
create or replace function public.conversation_update_guard()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from old.user_id
     or new.is_temporary is distinct from old.is_temporary
     or new.created_at is distinct from old.created_at then
    raise exception 'CONVERSATION_IMMUTABLE_FIELDS';
  end if;
  return new;
end $$;

drop trigger if exists conversation_update_guard on public.conversations;
create trigger conversation_update_guard
  before update on public.conversations
  for each row execute function public.conversation_update_guard();

-- Reports: users can only create their own 'submitted' reports.
create or replace function public.scam_report_guard()
returns trigger
language plpgsql
as $$
begin
  new.user_id := auth.uid();
  new.status := 'submitted';
  if new.user_id is null then raise exception 'NOT_AUTHENTICATED'; end if;
  return new;
end $$;

drop trigger if exists scam_report_guard on public.scam_reports;
create trigger scam_report_guard
  before insert on public.scam_reports
  for each row execute function public.scam_report_guard();

-- Identity verification rows: users create 'pending_review' rows for themselves.
create or replace function public.identity_verification_guard()
returns trigger
language plpgsql
as $$
begin
  new.user_id := auth.uid();
  new.verification_status := 'pending_review';
  if new.user_id is null then raise exception 'NOT_AUTHENTICATED'; end if;
  return new;
end $$;

drop trigger if exists identity_verification_guard on public.identity_verifications;
create trigger identity_verification_guard
  before insert on public.identity_verifications
  for each row execute function public.identity_verification_guard();

-- Memory: users may only store non-secret context (blocked patterns).
create or replace function public.user_memory_guard()
returns trigger
language plpgsql
as $$
begin
  new.user_id := auth.uid();
  if new.user_id is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if new.memory ~* '(password|passwd|otp|pin|birth certificate|national id|ssn|card number)' then
    raise exception 'MEMORY_SECRET_FORBIDDEN';
  end if;
  return new;
end $$;

drop trigger if exists user_memory_guard on public.user_memories;
create trigger user_memory_guard
  before insert or update on public.user_memories
  for each row execute function public.user_memory_guard();

-- =============================================================================
-- 14. updated_at TRIGGERS
-- =============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','identity_verifications','guardian_consents','user_security_settings',
    'conversations','conversation_summaries','user_memories',
    'scam_categories','scam_articles','scam_reports','reporting_resources',
    'courses','course_modules','lessons','quizzes','quiz_questions',
    'course_progress','certificates','notifications'
  ]
  loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s', t);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$s
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- =============================================================================
-- 15. GRANTS  (minimal privileges; RLS below is the real gate)
-- =============================================================================

revoke insert, update, delete on public.profiles from anon, authenticated;
revoke insert, update, delete on public.identity_verifications from anon, authenticated;
revoke insert, update, delete on public.guardian_consents from anon, authenticated;
revoke insert, update, delete on public.user_security_settings from anon, authenticated;
revoke insert, update, delete on public.oauth_profiles from anon, authenticated;
revoke insert, update, delete on public.conversation_summaries from anon, authenticated;
revoke insert, update, delete on public.security_analyses from anon, authenticated;
revoke insert, update, delete on public.quiz_attempts from anon, authenticated;
revoke insert, update, delete on public.course_progress from anon, authenticated;
revoke insert, update, delete on public.certificates from anon, authenticated;
revoke insert, update, delete on public.quiz_options from anon, authenticated;
revoke insert, update, delete on public.security_events from anon, authenticated;
revoke insert, update, delete on public.user_sessions from anon, authenticated;
revoke insert, update, delete on public.audit_logs from anon, authenticated;
revoke insert, update, delete on public.ai_usage_logs from anon, authenticated;
revoke insert, update, delete on public.ai_safety_events from anon, authenticated;
revoke insert, update, delete on public.certificate_verification from anon, authenticated;
revoke insert, update, delete on public.admin_access_grants from anon, authenticated;
revoke insert, update, delete on public.admin_role_assignments from anon, authenticated;
revoke insert, update, delete on public.admin_roles, public.admin_permissions, public.admin_role_permissions from anon, authenticated;
revoke insert on public.conversation_messages from anon, authenticated;
revoke update, delete on public.conversation_messages from anon, authenticated;
revoke insert, update, delete on public.conversations from anon, authenticated;
revoke delete on public.scam_reports from anon, authenticated;

-- Public quiz options view (never exposes is_correct to learners)
revoke select on public.quiz_options from anon, authenticated;
create or replace view public.quiz_options_public
with (security_invoker = false) as
select id, question_id, option_text, sort_order
from public.quiz_options;
grant select on public.quiz_options_public to anon, authenticated;

-- RPC grants
revoke execute on function public.rag_search(text, integer) from public, anon, authenticated;
grant execute on function public.validate_dob(date) to anon, authenticated;
grant execute on function public.calculate_age(date) to anon, authenticated;
grant execute on function public.complete_profile(date, text, text, text, text) to authenticated;
grant execute on function public.submit_guardian_consent(text, text, text) to authenticated;
grant execute on function public.record_security_event(text, jsonb) to authenticated;
grant execute on function public.revoke_session(uuid) to authenticated;
grant execute on function public.update_course_progress(uuid, text) to authenticated;
grant execute on function public.submit_quiz_attempt(uuid, jsonb) to authenticated;
grant execute on function public.issue_certificate(uuid) to authenticated;
grant execute on function public.security_score() to authenticated;
grant execute on function public.verify_certificate_lookup(text) to anon, authenticated;
grant execute on function public.check_certificate_eligibility(uuid, uuid) to authenticated;

-- =============================================================================
-- 16. ROW LEVEL SECURITY
-- =============================================================================

alter table public.profiles enable row level security;
alter table public.identity_verifications enable row level security;
alter table public.guardian_consents enable row level security;
alter table public.user_security_settings enable row level security;
alter table public.oauth_profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.conversation_summaries enable row level security;
alter table public.user_memories enable row level security;
alter table public.attachments enable row level security;
alter table public.security_analyses enable row level security;
alter table public.scam_categories enable row level security;
alter table public.scam_articles enable row level security;
alter table public.scam_reports enable row level security;
alter table public.reporting_resources enable row level security;
alter table public.countries enable row level security;
alter table public.document_chunks enable row level security;
alter table public.courses enable row level security;
alter table public.course_modules enable row level security;
alter table public.lessons enable row level security;
alter table public.quizzes enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_options enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.course_progress enable row level security;
alter table public.certificates enable row level security;
alter table public.certificate_verification enable row level security;
alter table public.notifications enable row level security;
alter table public.security_events enable row level security;
alter table public.user_sessions enable row level security;
alter table public.admin_roles enable row level security;
alter table public.admin_permissions enable row level security;
alter table public.admin_role_permissions enable row level security;
alter table public.admin_role_assignments enable row level security;
alter table public.audit_logs enable row level security;
alter table public.ai_usage_logs enable row level security;
alter table public.ai_safety_events enable row level security;
alter table public.admin_access_grants enable row level security;

-- profiles --------------------------------------------------------------------
create policy profiles_own_select on public.profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_own_update on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin_select on public.profiles
  for select to authenticated using (public.has_permission('users.view'));

-- identity_verifications ------------------------------------------------------
create policy iv_own_select on public.identity_verifications
  for select to authenticated using (user_id = auth.uid());
create policy iv_own_insert on public.identity_verifications
  for insert to authenticated with check (user_id = auth.uid());
create policy iv_admin_select on public.identity_verifications
  for select to authenticated using (public.has_permission('verification.review'));

-- guardian_consents -----------------------------------------------------------
create policy gc_own_select on public.guardian_consents
  for select to authenticated using (user_id = auth.uid());
create policy gc_admin_select on public.guardian_consents
  for select to authenticated using (public.has_permission('consent.review'));

-- user_security_settings ------------------------------------------------------
create policy uss_own_all on public.user_security_settings
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- oauth_profiles --------------------------------------------------------------
create policy op_own_select on public.oauth_profiles
  for select to authenticated using (user_id = auth.uid());

-- conversations ---------------------------------------------------------------
create policy conv_own_select on public.conversations
  for select to authenticated using (user_id = auth.uid());
create policy conv_own_update on public.conversations
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy conv_own_delete on public.conversations
  for delete to authenticated using (user_id = auth.uid());

-- conversation_messages -------------------------------------------------------
create policy msg_conv_select on public.conversation_messages
  for select to authenticated using (
    exists (select 1 from public.conversations c
            where c.id = conversation_id and c.user_id = auth.uid()));
create policy msg_conv_insert on public.conversation_messages
  for insert to authenticated with check (
    exists (select 1 from public.conversations c
            where c.id = conversation_id and c.user_id = auth.uid()));

-- conversation_summaries ------------------------------------------------------
create policy cs_conv_select on public.conversation_summaries
  for select to authenticated using (
    exists (select 1 from public.conversations c
            where c.id = conversation_id and c.user_id = auth.uid()));

-- user_memories ---------------------------------------------------------------
create policy mem_own_all on public.user_memories
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- attachments -----------------------------------------------------------------
create policy att_own_all on public.attachments
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- security_analyses -----------------------------------------------------------
create policy sa_own_select on public.security_analyses
  for select to authenticated using (user_id = auth.uid());

-- scam library: public reads of active content; admin writes ------------------
create policy scat_public_select on public.scam_categories
  for select to anon, authenticated using (status = 'active');
create policy scat_admin_all on public.scam_categories
  for all to authenticated using (public.has_permission('content.manage'))
  with check (public.has_permission('content.manage'));

create policy sa_public_select on public.scam_articles
  for select to anon, authenticated using (status = 'active');
create policy sa_admin_all on public.scam_articles
  for all to authenticated using (public.has_permission('content.manage'))
  with check (public.has_permission('content.manage'));

create policy sr_own_insert on public.scam_reports
  for insert to authenticated with check (user_id = auth.uid());
create policy sr_own_select on public.scam_reports
  for select to authenticated using (user_id = auth.uid());
create policy sr_admin_select on public.scam_reports
  for select to authenticated using (public.has_permission('reports.view'));
create policy sr_admin_update on public.scam_reports
  for update to authenticated using (public.has_permission('reports.view'))
  with check (public.has_permission('reports.view'));

create policy rr_public_select on public.reporting_resources
  for select to anon, authenticated using (status = 'active');
create policy rr_admin_all on public.reporting_resources
  for all to authenticated using (public.has_permission('content.manage'))
  with check (public.has_permission('content.manage'));

create policy co_public_select on public.countries
  for select to anon, authenticated using (true);

create policy dc_public_select on public.document_chunks
  for select to anon, authenticated using (trust_level <> 'user_generated');
create policy dc_admin_all on public.document_chunks
  for all to authenticated using (public.has_permission('content.manage'))
  with check (public.has_permission('content.manage'));

-- learning --------------------------------------------------------------------
create policy course_public_select on public.courses
  for select to anon, authenticated using (status = 'published');
create policy course_admin_all on public.courses
  for all to authenticated using (public.has_permission('content.manage'))
  with check (public.has_permission('content.manage'));

create policy cm_public_select on public.course_modules
  for select to anon, authenticated using (
    exists (select 1 from public.courses c where c.id = course_id and c.status = 'published'));
create policy cm_admin_all on public.course_modules
  for all to authenticated using (public.has_permission('content.manage'))
  with check (public.has_permission('content.manage'));

create policy lesson_public_select on public.lessons
  for select to anon, authenticated using (
    exists (select 1 from public.course_modules m
            join public.courses c on c.id = m.course_id
            where m.id = module_id and c.status = 'published'));
create policy lesson_admin_all on public.lessons
  for all to authenticated using (public.has_permission('content.manage'))
  with check (public.has_permission('content.manage'));

create policy quiz_public_select on public.quizzes
  for select to anon, authenticated using (
    exists (select 1 from public.course_modules m
            join public.courses c on c.id = m.course_id
            where m.id = module_id and c.status = 'published'));
create policy quiz_admin_all on public.quizzes
  for all to authenticated using (public.has_permission('content.manage'))
  with check (public.has_permission('content.manage'));

create policy qq_public_select on public.quiz_questions
  for select to anon, authenticated using (
    exists (select 1 from public.quizzes q
            join public.course_modules m on m.id = q.module_id
            join public.courses c on c.id = m.course_id
            where q.id = quiz_id and c.status = 'published'));
create policy qq_admin_all on public.quiz_questions
  for all to authenticated using (public.has_permission('content.manage'))
  with check (public.has_permission('content.manage'));

create policy qo_admin_all on public.quiz_options
  for all to authenticated using (public.has_permission('content.manage'))
  with check (public.has_permission('content.manage'));

create policy qa_own_select on public.quiz_attempts
  for select to authenticated using (user_id = auth.uid());
create policy qa_admin_select on public.quiz_attempts
  for select to authenticated using (public.has_permission('learning.view'));

create policy cp_own_select on public.course_progress
  for select to authenticated using (user_id = auth.uid());
create policy cp_admin_select on public.course_progress
  for select to authenticated using (public.has_permission('learning.view'));

-- certificates ----------------------------------------------------------------
create policy cert_own_select on public.certificates
  for select to authenticated using (user_id = auth.uid());
create policy cert_admin_select on public.certificates
  for select to authenticated using (public.has_permission('certificates.view'));

create policy cv_admin_select on public.certificate_verification
  for select to authenticated using (public.has_permission('audit.view'));

-- notifications ---------------------------------------------------------------
create policy notif_own_all on public.notifications
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- security_events -------------------------------------------------------------
create policy se_own_select on public.security_events
  for select to authenticated using (user_id = auth.uid());
create policy se_admin_select on public.security_events
  for select to authenticated using (public.has_permission('security.view'));

-- user_sessions ---------------------------------------------------------------
create policy us_own_select on public.user_sessions
  for select to authenticated using (user_id = auth.uid());
create policy us_admin_select on public.user_sessions
  for select to authenticated using (public.has_permission('security.view'));

-- admin tables ----------------------------------------------------------------
create policy admin_roles_admin_select on public.admin_roles
  for select to authenticated using (public.is_admin());
create policy admin_perms_admin_select on public.admin_permissions
  for select to authenticated using (public.is_admin());
create policy admin_rp_admin_select on public.admin_role_permissions
  for select to authenticated using (public.is_admin());
create policy admin_ra_admin_select on public.admin_role_assignments
  for select to authenticated using (public.is_admin());
create policy admin_ra_admin_insert on public.admin_role_assignments
  for insert to authenticated with check (
    public.has_permission('admin.manage'));
create policy admin_ra_admin_delete on public.admin_role_assignments
  for delete to authenticated using (public.has_permission('admin.manage'));

create policy audit_admin_select on public.audit_logs
  for select to authenticated using (public.has_permission('audit.view'));

create policy ai_usage_own_select on public.ai_usage_logs
  for select to authenticated using (user_id = auth.uid());
create policy ai_usage_admin_select on public.ai_usage_logs
  for select to authenticated using (public.has_permission('ai.view'));

create policy ai_safety_admin_select on public.ai_safety_events
  for select to authenticated using (public.has_permission('ai.view'));

create policy aag_own_select on public.admin_access_grants
  for select to authenticated using (requester_id = auth.uid());
create policy aag_admin_select on public.admin_access_grants
  for select to authenticated using (public.has_permission('privacy.access'));
