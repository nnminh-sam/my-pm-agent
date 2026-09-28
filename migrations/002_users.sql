-- Columns mirror UserMeta in src/lib/types.ts. Ids keep their U-n form, allocated from their own sequence.
-- Emails are stored normalized (trimmed, lowercased) by src/lib/repo.ts, so a plain unique constraint suffices.
-- Users are not part of import/export (src/lib/transfer.ts): backups carry no password hashes.

create sequence user_id_seq;

create table users (
  id text primary key default ('U-' || nextval('user_id_seq')) check (id ~ '^U-[0-9]+$'),
  email text not null unique,
  password_hash text not null,
  created date not null
);
alter sequence user_id_seq owned by users.id;
