-- Down for 001_identity. Dropping a partitioned parent drops its partitions.
drop table if exists relationships cascade;
drop table if exists devices cascade;
drop table if exists users cascade;
drop table if exists schema_migrations cascade;
