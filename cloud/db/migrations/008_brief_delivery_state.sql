-- 008_brief_delivery_state — so a failed morning can be retried.
--
-- Reversible: yes — 008_brief_delivery_state.down.sql
--
-- THE BUG THIS FIXES. `run.ts` inserted the brief row BEFORE calling the channel and
-- nothing was transactional, so a send that threw left the row behind. The next attempt
-- found it, returned `already_sent`, and stopped. `briefs.delivered_at` existed and
-- nothing ever wrote it.
--
-- Concretely: Linq returns 503 line_banned at 08:00 — the exact case Track C built the
-- adapter for — and the user gets no brief that morning, silently, forever. The brief is
-- the retention product. A morning that fails and disappears without a trace is the
-- worst available outcome, and the bounded retry that was supposed to cover it could
-- never fire.
--
-- The row still gets written first, deliberately: a skip has to outlive the log
-- retention window so "why didn't I get one" has an answer. What changes is that the
-- row now records WHAT HAPPENED, and only a terminal state short-circuits the next
-- attempt.
alter table briefs add column if not exists delivery_status text not null default 'pending';
alter table briefs add column if not exists attempts integer not null default 0;
alter table briefs add column if not exists last_error text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'briefs_delivery_status_known') then
    alter table briefs add constraint briefs_delivery_status_known
      check (delivery_status in ('pending', 'sent', 'skipped', 'exhausted'));
  end if;
  -- 'sent' without a delivered_at is the inconsistency that started all this.
  if not exists (select 1 from pg_constraint where conname = 'briefs_sent_has_timestamp') then
    alter table briefs add constraint briefs_sent_has_timestamp
      check (delivery_status <> 'sent' or delivered_at is not null);
  end if;
end $$;

-- The scheduler's retry sweep reads this.
create index if not exists briefs_pending_idx
  on briefs (user_id, delivery_status) where delivery_status = 'pending';
