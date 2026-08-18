-- =============================================================================
-- MATRIX AI — 0001: Core identity schema
-- profiles, identity_verifications, guardian_consents, user_security_settings,
-- oauth_profiles, countries
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- profiles  (profiles.id = auth.users.id, never store auth secrets here)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  full_name     text not null default '',
  email         text not null default '',
  date_of_birth date,                       -- validated by public.validate_dob()
  age_verified  boolean not null default false,
  age_verified_at timestamptz,
  school_name   text not null default '',
  class_grade   text not null default '',
  address       text not null default '',
  country       text references public.countries(id) default 'US',
  phone         text not null default '',
  avatar_url    text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint profiles_email_not_blank check (length(trim(email)) > 0)
);

create index profiles_country_idx on public.profiles(country);
create index profiles_created_at_idx on public.profiles(created_at);

-- ---------------------------------------------------------------------------
-- countries  (consent requirements are configurable per country)
-- ---------------------------------------------------------------------------
create table public.countries (
  id                text primary key,          -- ISO 3166-1 alpha-2
  name              text not null,
  consent_required  boolean not null default true,
  consent_min_age   integer not null default 13
                     check (consent_min_age between 0 and 18),
  reporting_note    text not null default ''
);

-- ---------------------------------------------------------------------------
-- identity_verifications  (age verification; store a reference, not the doc)
-- ---------------------------------------------------------------------------
create table public.identity_verifications (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  verification_type     text not null default 'birth_certificate'
                          check (verification_type in (
                            'birth_certificate','passport','national_id','external_provider')),
  verification_status   text not null default 'pending_review'
                          check (verification_status in (
                            'pending_review','approved','rejected','expired','revoked')),
  verification_reference text not null default '',  -- storage path / provider ref (no raw doc number)
  reviewer_id           uuid references auth.users(id),
  rejection_reason      text not null default '',
  verified_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index identity_verifications_user_idx on public.identity_verifications(user_id);
create index identity_verifications_status_idx on public.identity_verifications(verification_status);

-- ---------------------------------------------------------------------------
-- guardian_consents  (configurable consent per country, see public.countries)
-- ---------------------------------------------------------------------------
create table public.guardian_consents (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  status              text not null default 'pending'
                        check (status in ('pending','approved','revoked','expired')),
  consent_method      text not null default 'self'
                        check (consent_method in ('self','guardian','parent')),
  guardian_name       text not null default '',
  guardian_email      text not null default '',
  guardian_relationship text not null default '',
  consented_at        timestamptz,
  revoked_at          timestamptz,
  expires_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint guardian_consents_one_per_user unique (user_id)
);

-- ---------------------------------------------------------------------------
-- user_security_settings  (app-level security/consent preferences)
-- ---------------------------------------------------------------------------
create table public.user_security_settings (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  memory_enabled      boolean not null default true,
  chat_history_enabled boolean not null default true,
  notifications_email boolean not null default true,
  notifications_push  boolean not null default false,
  notifications_security_alerts boolean not null default true,
  data_export_requested_at timestamptz,
  deletion_requested_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- oauth_profiles  (app-level OAuth account linking; auth secrets stay in
-- auth.identities — never duplicated here)
-- ---------------------------------------------------------------------------
create table public.oauth_profiles (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  provider         text not null check (provider in ('google','facebook','apple','github','email')),
  provider_user_id text not null,
  linked_at        timestamptz not null default now(),
  constraint oauth_profiles_unique_account unique (provider, provider_user_id)
);

create index oauth_profiles_user_idx on public.oauth_profiles(user_id);
