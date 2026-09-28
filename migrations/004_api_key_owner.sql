-- API keys created in the web UI belong to the signed-in account (ApiKeyMeta.user_id in src/lib/types.ts).
-- Keys issued with `npm run auth:create-key` have no owner (NULL). Deleting an account deletes its keys.

alter table api_keys add column user_id text references users (id) on delete cascade check (user_id ~ '^U-[0-9]+$');
create index api_keys_user_id_idx on api_keys (user_id);
