-- =============================================================================
-- MATRIX AI — 0004: Learning (courses, lessons, quizzes, progress, certificates)
-- =============================================================================

create table public.courses (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  title        text not null,
  description  text not null default '',
  level        text not null default 'beginner' check (level in ('beginner','intermediate','advanced')),
  duration_minutes integer not null default 30 check (duration_minutes > 0),
  icon         text not null default 'book',
  status       text not null default 'published' check (status in ('draft','published','archived')),
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.course_modules (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references public.courses(id) on delete cascade,
  title       text not null,
  description text not null default '',
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint course_modules_unique_order unique (course_id, sort_order)
);

create table public.lessons (
  id          uuid primary key default gen_random_uuid(),
  module_id   uuid not null references public.course_modules(id) on delete cascade,
  title       text not null,
  summary     text not null default '',
  body        text not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint lessons_unique_order unique (module_id, sort_order)
);

create table public.quizzes (
  id          uuid primary key default gen_random_uuid(),
  module_id   uuid not null references public.course_modules(id) on delete cascade,
  title       text not null,
  pass_percent integer not null default 60 check (pass_percent between 0 and 100),
  max_attempts integer not null default 0,   -- 0 = unlimited
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint quizzes_unique_order unique (module_id, sort_order)
);

create table public.quiz_questions (
  id          uuid primary key default gen_random_uuid(),
  quiz_id     uuid not null references public.quizzes(id) on delete cascade,
  question    text not null,
  explanation text not null default '',
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint quiz_questions_unique_order unique (quiz_id, sort_order)
);

create table public.quiz_options (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  option_text text not null,
  is_correct  boolean not null default false,
  sort_order  integer not null default 0,
  constraint quiz_options_unique_order unique (question_id, sort_order)
);

-- ---------------------------------------------------------------------------
-- quiz_attempts  (scores computed by public.submit_quiz_attempt — never client)
-- ---------------------------------------------------------------------------
create table public.quiz_attempts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  quiz_id       uuid not null references public.quizzes(id) on delete cascade,
  score_percent numeric(5,2) not null check (score_percent between 0 and 100),
  passed        boolean not null default false,
  answers       jsonb not null default '[]'::jsonb,
  started_at    timestamptz not null default now(),
  completed_at  timestamptz not null default now()
);

create index quiz_attempts_user_idx on public.quiz_attempts(user_id, quiz_id, completed_at desc);

-- ---------------------------------------------------------------------------
-- course_progress  (one row per user+lesson; values constrained)
-- ---------------------------------------------------------------------------
create table public.course_progress (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  lesson_id    uuid not null references public.lessons(id) on delete cascade,
  status       text not null default 'started'
                 check (status in ('started','completed')),
  progress     integer not null default 0 check (progress between 0 and 100),
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint course_progress_unique unique (user_id, lesson_id),
  constraint course_progress_status_consistent check (
    (status = 'completed' and progress = 100 and completed_at is not null) or
    (status <> 'completed')
  )
);

-- ---------------------------------------------------------------------------
-- certificates  (certificate_id is unique and public-safe)
-- ---------------------------------------------------------------------------
create table public.certificates (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  course_id           uuid not null references public.courses(id) on delete restrict,
  certificate_id      text not null unique,
  issued_at           timestamptz not null default now(),
  verification_status text not null default 'valid'
                         check (verification_status in ('valid','revoked')),
  revoked_at          timestamptz,
  created_at          timestamptz not null default now(),
  constraint certificates_one_per_course unique (user_id, course_id)
);

create index certificates_user_idx on public.certificates(user_id, issued_at desc);
create index certificates_course_idx on public.certificates(course_id);

-- ---------------------------------------------------------------------------
-- certificate_verification  (public verification log — no private data)
-- ---------------------------------------------------------------------------
create table public.certificate_verification (
  id             uuid primary key default gen_random_uuid(),
  certificate_id text not null,
  verified_at    timestamptz not null default now(),
  ip_hash        text not null default ''
);

create index certificate_verification_cert_idx on public.certificate_verification(certificate_id);
