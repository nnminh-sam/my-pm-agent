-- Columns mirror ApiKeyMeta in src/lib/types.ts. Ids keep their K-n form, allocated from their own sequence.
-- Only the SHA-256 of each key is stored (lowercase hex, see src/lib/auth/api-keys.ts); lookups go by hash.
-- Revocation is a soft delete: revoked_at is set and the row stays, so listings keep the history.
-- API keys are not part of import/export (src/lib/transfer.ts), like users.

create sequence api_key_id_seq;

create table api_keys (
  id text primary key default ('K-' || nextval('api_key_id_seq')) check (id ~ '^K-[0-9]+$'),
  label text not null default '',
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  created date not null,
  last_used_at timestamptz,
  revoked_at timestamptz
);
alter sequence api_key_id_seq owned by api_keys.id;
create unique index api_keys_hash_idx on api_keys (hash);
