-- Stores the last durably committed Spectrum stream cursor per user.
-- One row per paired user; updated atomically after the inbound router processes an event.
create table if not exists stream_checkpoints (
  user_id text not null references users,
  cursor text not null,
  updated_at timestamp with time zone not null default now(),
  primary key (user_id)
);
