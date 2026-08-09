-- 017_v3_persons_identities_interactions — the v3 multi-source identity model.
--
-- Reversible: yes — 017_v3_persons_identities_interactions.down.sql
--
-- persons  — one row per real-world human, regardless of how they contact you.
-- identities — one row per handle/address, attached to a person.
-- interactions — source-agnostic unit of evidence. Replaces "message" downstream.
--
-- person_id, NOT contact_id. contact_id is an iMessage handle cluster; the roadmap
-- adds Gmail, Calendar, Photos and call history, where the same human arrives through
-- a different handle. Getting this wrong means rekeying every relationship table later.

create table if not exists persons (
  user_id    text not null references users(user_id) on delete cascade,
  person_id  text primary key,
  display    text not null,
  created_at timestamptz not null default now()
) partition by hash (user_id);

create table if not exists identities (
  user_id     text not null references users(user_id) on delete cascade,
  identity_id text primary key,
  person_id   text not null,
  source      text not null,
  handle      text not null,
  confidence  text not null,
  merged_by   text,
  as_of       timestamptz not null,
  unique (user_id, source, handle)
) partition by hash (user_id);

create table if not exists interactions (
  user_id        text not null references users(user_id) on delete cascade,
  interaction_id text primary key,
  person_id      text not null,
  source         text not null,
  direction      text not null,
  occurred_at    timestamptz not null,
  thread_ref     text,
  content_ref    text,
  length         int,
  meta           jsonb not null default '{}'
) partition by hash (user_id);

do $$
declare
  t text;
  i int;
begin
  foreach t in array array['persons', 'identities', 'interactions'] loop
    for i in 0..7 loop
      execute format(
        'create table if not exists %I partition of %I for values with (modulus 8, remainder %s)',
        t || '_p' || i, t, i
      );
    end loop;
  end loop;
end $$;
