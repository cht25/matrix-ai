-- =============================================================================
-- MATRIX AI — 0003: Scam library, reports, verified reporting resources, RAG
-- =============================================================================

-- ---------------------------------------------------------------------------
-- scam_categories
-- ---------------------------------------------------------------------------
create table public.scam_categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  description text not null default '',
  icon        text not null default 'shield',
  sort_order  integer not null default 0,
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- scam_articles  (only trusted/verified resources are marked active)
-- ---------------------------------------------------------------------------
create table public.scam_articles (
  id                uuid primary key default gen_random_uuid(),
  category_id       uuid not null references public.scam_categories(id) on delete restrict,
  title             text not null,
  slug              text not null unique,
  description       text not null default '',
  warning_signs     text not null default '',
  prevention        text not null default '',
  response_steps    text not null default '',
  reporting_guidance text not null default '',
  source_name       text not null default '',
  source_url        text not null default '',
  country           text references public.countries(id),
  trust_level       text not null default 'trusted_internal'
                      check (trust_level in ('trusted_official','trusted_internal','review_required','user_generated')),
  last_verified     timestamptz,
  status            text not null default 'active' check (status in ('active','inactive','review')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index scam_articles_category_idx on public.scam_articles(category_id, status);
create index scam_articles_status_idx on public.scam_articles(status);
create index scam_articles_search_idx on public.scam_articles
  using gin (to_tsvector('simple', title || ' ' || description || ' ' || warning_signs || ' ' || prevention));

-- ---------------------------------------------------------------------------
-- scam_reports  (user reports; private, protected by RLS)
-- ---------------------------------------------------------------------------
create table public.scam_reports (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null references auth.users(id) on delete cascade,
  category_id                uuid references public.scam_categories(id) on delete set null,
  platform                   text not null default '',
  description                text not null,
  money_lost                 numeric(12,2) not null default 0 check (money_lost >= 0),
  account_compromised        boolean not null default false,
  personal_information_shared boolean not null default false,
  evidence_available         boolean not null default false,
  country                    text references public.countries(id),
  status                     text not null default 'submitted'
                               check (status in ('submitted','in_review','resolved','closed')),
  admin_notes                text not null default '',
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create index scam_reports_user_idx on public.scam_reports(user_id, created_at desc);
create index scam_reports_status_idx on public.scam_reports(status);

-- ---------------------------------------------------------------------------
-- reporting_resources  (verified official reporting contacts — AI never invents)
-- ---------------------------------------------------------------------------
create table public.reporting_resources (
  id               uuid primary key default gen_random_uuid(),
  country_id       text not null references public.countries(id) on delete cascade,
  organization     text not null,
  category         text not null default 'scam'
                     check (category in ('scam','cybercrime','consumer','data','abuse')),
  official_url     text not null,
  phone            text not null default '',
  description      text not null default '',
  last_verified    timestamptz not null default now(),
  status           text not null default 'active' check (status in ('active','inactive')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index reporting_resources_country_idx on public.reporting_resources(country_id, status);

-- ---------------------------------------------------------------------------
-- document_chunks  (RAG knowledge store; tsvector search, pgvector-ready)
-- Only approved trusted sources become authoritative knowledge.
-- ---------------------------------------------------------------------------
create table public.document_chunks (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  content       text not null,
  source_type   text not null default 'knowledge'
                  check (source_type in ('knowledge','scam_article','lesson','reporting_resource')),
  source_id     uuid,
  trust_level   text not null default 'trusted_internal'
                  check (trust_level in ('trusted_official','trusted_internal','review_required','user_generated')),
  language      text not null default 'en',
  search_vector tsvector generated always as (
    to_tsvector('simple', title || ' ' || content)
  ) stored,
  created_at    timestamptz not null default now()
);

create index document_chunks_search_idx on public.document_chunks using gin (search_vector);
create index document_chunks_trust_idx on public.document_chunks(trust_level);
-- pgvector is optional: enable later with `create extension vector;` and add:
-- alter table public.document_chunks add column embedding vector(1536);
