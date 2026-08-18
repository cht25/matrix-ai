-- =============================================================================
-- MATRIX AI — 0005: Security events, sessions, notifications, admin RBAC,
-- audit logs, AI usage & safety logs
-- =============================================================================

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  type       text not null default 'info'
               check (type in ('info','security','course','certificate','report')),
  title      text not null,
  body       text not null default '',
  link       text not null default '',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_idx on public.notifications(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- security_events  (never log secrets)
-- ---------------------------------------------------------------------------
create table public.security_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  event_type  text not null check (event_type in (
                'login','logout','password_changed','password_reset','email_changed',
                'mfa_enabled','mfa_disabled','new_device','suspicious_activity',
                'account_locked','identity_verified','consent_approved','consent_revoked',
                'data_exported','deletion_requested')),
  metadata    jsonb not null default '{}'::jsonb,
  ip_hash     text not null default '',
  created_at  timestamptz not null default now()
);

create index security_events_user_idx on public.security_events(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- user_sessions  (device sessions; users can revoke their own)
-- ---------------------------------------------------------------------------
create table public.user_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  session_ref  text not null default '',   -- opaque reference, never a token
  device_name  text not null default '',
  ip_hash      text not null default '',
  user_agent   text not null default '',
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index user_sessions_user_idx on public.user_sessions(user_id, last_seen_at desc);

-- ---------------------------------------------------------------------------
-- Admin RBAC  (role-based, NOT is_admin flags)
-- ---------------------------------------------------------------------------
create table public.admin_roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (name in (
                'super_admin','security_admin','content_admin','support_admin','auditor')),
  description text not null default '',
  created_at  timestamptz not null default now()
);

create table public.admin_permissions (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  description text not null default '',
  created_at  timestamptz not null default now()
);

create table public.admin_role_permissions (
  role_id       uuid not null references public.admin_roles(id) on delete cascade,
  permission_id uuid not null references public.admin_permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table public.admin_role_assignments (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role_id    uuid not null references public.admin_roles(id) on delete cascade,
  assigned_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- audit_logs  (sensitive admin actions; no sensitive content stored)
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid references auth.users(id) on delete set null,
  action      text not null,
  target_type text not null default '',
  target_id   text not null default '',
  reason      text not null default '',
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index audit_logs_actor_idx on public.audit_logs(actor_id, created_at desc);
create index audit_logs_target_idx on public.audit_logs(target_type, target_id);

-- ---------------------------------------------------------------------------
-- ai_usage_logs  (safe metadata only — never raw prompts)
-- ---------------------------------------------------------------------------
create table public.ai_usage_logs (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  model        text not null,
  request_type text not null default 'chat' check (request_type in ('chat','scan','summary','report')),
  token_usage  jsonb not null default '{}'::jsonb,
  latency_ms   integer not null default 0,
  status       text not null default 'ok' check (status in ('ok','error','refused','redacted')),
  created_at   timestamptz not null default now()
);

create index ai_usage_logs_user_idx on public.ai_usage_logs(user_id, created_at desc);
create index ai_usage_logs_created_idx on public.ai_usage_logs(created_at);

-- ---------------------------------------------------------------------------
-- ai_safety_events  (off-topic, harmful requests, injections, PII, refusals)
-- ---------------------------------------------------------------------------
create table public.ai_safety_events (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete set null,
  event_type  text not null check (event_type in (
                'off_topic','harmful_request','prompt_injection','pii_detected',
                'safety_refusal','domain_refusal','output_blocked')),
  detail      text not null default '',   -- minimal safe metadata, never raw secrets
  created_at  timestamptz not null default now()
);

create index ai_safety_events_created_idx on public.ai_safety_events(created_at desc);

-- ---------------------------------------------------------------------------
-- admin_access_grants  (time-limited, audited access to user conversations)
-- ---------------------------------------------------------------------------
create table public.admin_access_grants (
  id              uuid primary key default gen_random_uuid(),
  requester_id    uuid not null references auth.users(id) on delete cascade,
  target_user_id  uuid not null references auth.users(id) on delete cascade,
  scope           text not null default 'conversations'
                    check (scope in ('conversations','messages','attachments')),
  reason          text not null,
  status          text not null default 'active' check (status in ('active','expired','revoked')),
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  constraint admin_access_grants_reason_not_blank check (length(trim(reason)) > 0)
);

create index admin_access_grants_target_idx on public.admin_access_grants(target_user_id);
