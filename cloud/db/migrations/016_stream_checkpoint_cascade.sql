-- Adds ON DELETE CASCADE to the stream_checkpoints foreign key.
-- Migration 015's `references users` lacked cascade, which causes deleteUser
-- to fail with a foreign-key violation when a stream checkpoint row exists.
alter table stream_checkpoints
  drop constraint stream_checkpoints_user_id_fkey,
  add constraint stream_checkpoints_user_id_fkey
    foreign key (user_id) references users on delete cascade;
