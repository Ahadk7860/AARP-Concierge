-- Revert: remove cascade from stream_checkpoints (restore 015 original behavior).
alter table stream_checkpoints
  drop constraint stream_checkpoints_user_id_fkey,
  add constraint stream_checkpoints_user_id_fkey
    foreign key (user_id) references users;
