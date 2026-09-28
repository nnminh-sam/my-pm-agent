import { createHash, randomBytes } from "node:crypto";
import { createApiKey, findApiKeyByHash, getApiKey, normalizeId, revokeApiKey, touchApiKey } from "../repo";
import type { ApiKey } from "../types";

/**
 * Agent API keys: `pm_` + 43 base64url chars (32 random bytes), sent as `Authorization: Bearer <key>`.
 * Only the SHA-256 of a key is stored; the raw key is shown once at issuance and never persisted.
 * Never log raw keys or their hashes.
 */

export const API_KEY_PREFIX = "pm_";

const KEY_BYTES = 32;
const KEY_BODY = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 bytes, unpadded
/** Labels are free-form notes ("claude-code laptop"); longer ones are cut. */
export const API_KEY_LABEL_MAX = 60;
/** `last_used_at` is refreshed at most this often, so MCP calls don't each cost a write. */
const TOUCH_INTERVAL_MS = 60_000;

export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(KEY_BYTES).toString("base64url");
}

// Plain SHA-256, not an HMAC keyed on JWT_SECRET: keys are 256-bit random, and rotating JWT_SECRET must not invalidate them.
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Shape check only, so JWTs, PM_SECRET and other bearer tokens never trigger a key lookup. */
export function looksLikeApiKey(token: string): boolean {
  return typeof token === "string" && token.startsWith(API_KEY_PREFIX) && KEY_BODY.test(token.slice(API_KEY_PREFIX.length));
}

/**
 * The active key matching `raw`, or null (malformed, unknown or revoked). On success `last_used_at` is
 * refreshed when unset or older than a minute; a failure to record it doesn't fail the authentication.
 * A lookup failure (repository error) rejects; callers must treat that as "not authenticated".
 */
export async function verifyApiKey(raw: string, { now = new Date() }: { now?: Date } = {}): Promise<ApiKey | null> {
  if (!looksLikeApiKey(raw)) return null;
  const key = await findApiKeyByHash(hashApiKey(raw));
  if (!key || key.revoked_at) return null;

  const lastUsed = key.last_used_at ? Date.parse(key.last_used_at) : NaN;
  if (Number.isNaN(lastUsed) || now.getTime() - lastUsed >= TOUCH_INTERVAL_MS) {
    try {
      const touched = await touchApiKey(key.id, now);
      // Revoked between the lookup and the touch: the touch kept revoked_at, and the key is refused.
      if (touched?.revoked_at) return null;
      return touched ?? key;
    } catch {
      // Id only: never the key or its hash.
      console.warn(`API key ${key.id}: could not record last use`);
    }
  }
  return key;
}

/**
 * Generates a key and stores only its hash. The returned `raw` key is the one and only time it exists
 * outside the client: show it once, never log or persist it. `userId` is the owning account (web UI).
 */
export async function issueApiKey({ label = "", userId }: { label?: string; userId?: string } = {}) {
  const raw = generateApiKey();
  const key = await createApiKey({ label: label.trim().slice(0, API_KEY_LABEL_MAX), hash: hashApiKey(raw), user_id: userId });
  return { key, raw };
}

/** Revokes a key the account owns (idempotent); null when the key doesn't exist or belongs to someone else. */
export async function revokeOwnApiKey(userId: string, id: string): Promise<ApiKey | null> {
  const key = await getApiKey(id);
  if (!key || key.user_id !== normalizeId(userId, "U")) return null;
  return revokeApiKey(key.id);
}

/** What the web UI may see of a key: everything but the hash. */
export type PublicApiKey = Omit<ApiKey, "hash">;
export function toPublicApiKey(key: ApiKey): PublicApiKey {
  const shown: Partial<ApiKey> = { ...key };
  delete shown.hash;
  return shown as PublicApiKey;
}
