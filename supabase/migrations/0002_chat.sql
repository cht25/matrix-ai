-- =============================================================================
-- MATRIX AI — 0002: Chat, memory, attachments, security analyses
-- =============================================================================

-- ---------------------------------------------------------------------------
-- conversations  (is_temporary chats never appear in history/search)
-- ---------------------------------------------------------------------------
create table public.conversations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  title         text not null default 'New conversation',
  is_temporary  boolean not null default false,
  summary       text not null default '',
  archived_at   timestamptz,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint conversations_title_not_blank check (length(trim(title)) > 0)
);

create index conversations_user_idx on public.conversations(user_id, created_at desc);
create index conversations_user_active_idx
  on public.conversations(user_id, is_temporary, deleted_at);

-- ---------------------------------------------------------------------------
-- conversation_messages  (roles: user, assistant, system — system never exposed)
-- ---------------------------------------------------------------------------
create table public.conversation_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant','system')),
  content         text not null,
  metadata        jsonb not null default '{}'::jsonb,   -- e.g. {"pii_redacted": true}
  created_at      timestamptz not null default now()
);

create index conversation_messages_conv_idx
  on public.conversation_messages(conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- conversation_summaries  (rolling summary; temp chats never get one)
-- ---------------------------------------------------------------------------
create table public.conversation_summaries (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  summary         text not null,
  message_count   integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint conversation_summaries_one_per_conv unique (conversation_id)
);

-- ---------------------------------------------------------------------------
-- user_memories  (safe, useful context only — never secrets)
-- ---------------------------------------------------------------------------
create table public.user_memories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  memory      text not null,
  source      text not null default 'ai' check (source in ('ai','user','system')),
  is_private  boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint user_memories_not_blank check (length(trim(memory)) > 0)
);

create index user_memories_user_idx on public.user_memories(user_id);

-- ---------------------------------------------------------------------------
-- attachments  (chat attachments stored in private storage bucket)
-- ---------------------------------------------------------------------------
create table public.attachments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  storage_path    text not null,
  file_name       text not null,
  mime_type       text not null,
  file_size       bigint not null check (file_size > 0),
  checksum        text not null default '',
  created_at      timestamptz not null default now()
);

create index attachments_user_idx on public.attachments(user_id);
create index attachments_conv_idx on public.attachments(conversation_id);

-- ---------------------------------------------------------------------------
-- security_analyses  (screenshot scanner results)
-- ---------------------------------------------------------------------------
create table public.security_analyses (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  analysis_type    text not null default 'screenshot'
                     check (analysis_type in ('screenshot','link','message','report')),
  input_reference  text not null default '',   -- storage path of the analyzed file
  risk_level       text not null default 'unknown'
                     check (risk_level in ('low','medium','high','critical','unknown')),
  confidence       numeric(4,3) not null default 0 check (confidence between 0 and 1),
  findings         jsonb not null default '[]'::jsonb,
  recommendation   text not null default '',
  redaction_applied boolean not null default false,
  created_at       timestamptz not null default now()
);

create index security_analyses_user_idx on public.security_analyses(user_id, created_at desc);
