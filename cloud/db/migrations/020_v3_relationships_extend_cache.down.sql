drop table if exists precomputed_answers cascade;

alter table relationships
  drop column if exists lifecycle_stage,
  drop column if exists tie_context,
  drop column if exists expected_gap_days,
  drop column if exists overdue_by_days,
  drop column if exists response_latency_me_min,
  drop column if exists response_latency_them_min,
  drop column if exists importance;
