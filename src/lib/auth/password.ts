import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt. Encoded as `scrypt$<log2N>$<r>$<p>$<salt b64url>$<hash b64url>`;
 * verification reads the params from the string, so they can be raised later without a migration.
 * Never log passwords or hashes.
 */

export type ScryptParams = { log2N: number; r: number; p: number };

export const DEFAULT_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({ log2N: 17, r: 8, p: 1 });
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MiB = 1024 * 1024;
// Upper bound on 128·N·r·p (≈ memory and CPU cost) so a crafted hash can't DoS verification.
const MAX_COST_BYTES = 256 * MiB;
const MAX_LOG2N = 20;
const MAX_R = 32;
const MAX_P = 16;

function checkParams({ log2N, r, p }: ScryptParams): boolean {
  const ok = (v: number, max: number) => Number.isInteger(v) && v >= 1 && v <= max;
  return ok(log2N, MAX_LOG2N) && ok(r, MAX_R) && ok(p, MAX_P) && 128 * 2 ** log2N * r * p <= MAX_COST_BYTES;
}

function scrypt(password: string, salt: Buffer, keylen: number, { log2N, r, p }: ScryptParams): Promise<Buffer> {
  const N = 2 ** log2N;
  // OpenSSL needs ~128·N·r + 128·r·p bytes; double the nominal cost for headroom (256 MiB at the defaults).
  const options: ScryptOptions = { N, r, p, maxmem: Math.max(32 * MiB, 2 * 128 * N * r * p) };
  return new Promise((resolve, reject) =>
    scryptCallback(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string, params: Partial<ScryptParams> = {}): Promise<string> {
  const p = { ...DEFAULT_SCRYPT_PARAMS, ...params };
  if (!checkParams(p)) throw new Error("Invalid scrypt parameters");
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scrypt(password, salt, KEY_LENGTH, p);
  return ["scrypt", p.log2N, p.r, p.p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

const INT = /^[1-9][0-9]{0,5}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** Canonical base64url → bytes within [min, max] length, else null. */
function decode(s: string, min: number, max: number): Buffer | null {
  if (!B64URL.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  if (buf.length < min || buf.length > max || buf.toString("base64url") !== s) return null;
  return buf;
}

function parse(encoded: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, log2N, r, p, salt, hash] = parts;
  if (![log2N, r, p].every((v) => INT.test(v))) return null;
  const params = { log2N: Number(log2N), r: Number(r), p: Number(p) };
  if (!checkParams(params)) return null;
  const saltBuf = decode(salt, 8, 64);
  const hashBuf = decode(hash, 16, 128);
  return saltBuf && hashBuf ? { params, salt: saltBuf, hash: hashBuf } : null;
}

/** True iff `password` matches `encoded`. Malformed input yields false; never throws. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    if (typeof password !== "string" || typeof encoded !== "string") return false;
    const parsed = parse(encoded);
    if (!parsed) return false;
    const actual = await scrypt(password, parsed.salt, parsed.hash.length, parsed.params);
    return timingSafeEqual(actual, parsed.hash);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * A valid hash (production params) of a random password, generated once per process. Login verifies
 * against it for unknown emails so response timing doesn't reveal whether an account exists.
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString("base64url")).catch((err) => {
    dummyHash = null;
    throw err;
  });
  return dummyHash;
}

/** Password policy: returns an error message, or null when acceptable. */
export function validatePassword(password: string, email?: string): string | null {
  // Code points, not UTF-16 units; skip the spread for huge inputs (≥ length/2 code points anyway).
  const length = password.length > 2 * MAX_PASSWORD_LENGTH ? password.length : [...password].length;
  if (length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) {
    return "Password must not be the same as the email.";
  }
  return null;
}
