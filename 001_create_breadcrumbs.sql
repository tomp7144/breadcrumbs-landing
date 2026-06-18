-- Breadcrumbs table
-- One active breadcrumb per phone number, refreshed on every new text in.
-- Encrypted message blob holds the parsed fields (what_working_on, current_thought,
-- next_step, open_question) as a single encrypted JSON string — nothing readable
-- in plain text, including by the founder.

create table if not exists breadcrumbs (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null,
  encrypted_message text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  warned_at timestamptz,        -- when the "clearing my desk" message was sent
  created_at timestamptz not null default now(),
  last_updated_at timestamptz not null default now(),
  archived_at timestamptz
);

-- One active breadcrumb per phone number at a time.
-- Partial unique index: only enforced while status = 'active'.
create unique index if not exists one_active_breadcrumb_per_phone
  on breadcrumbs (phone_number)
  where status = 'active';

-- Speeds up the cron job's lookup of stale active rows.
create index if not exists idx_breadcrumbs_active_last_updated
  on breadcrumbs (last_updated_at)
  where status = 'active';

-- Speeds up the cron job's lookup of stale archived rows for final deletion.
create index if not exists idx_breadcrumbs_archived_at
  on breadcrumbs (archived_at)
  where status = 'archived';

comment on table breadcrumbs is
  'Single active memory slot per phone number. 14 days active, then warned + archived. 14 days archived, then hard deleted. Message content is encrypted application-side before insert; this table never holds plaintext.';
