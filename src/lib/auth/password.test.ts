import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDummyHash, hashPassword, validatePassword, verifyPassword } from "./password";

const cheap = { log2N: 10 }; // keep tests fast; one test below exercises the defaults
const pw = "correct horse battery staple";

describe("hashPassword / verifyPassword", () => {
  it("round-trips and rejects a wrong password", async () => {
    const encoded = await hashPassword(pw, cheap);
    expect(encoded).toMatch(/^scrypt\$10\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(await verifyPassword(pw, encoded)).toBe(true);
    expect(await verifyPassword(pw + "!", encoded)).toBe(false);
    expect(await verifyPassword("", encoded)).toBe(false);
  });

  it("uses a fresh salt per hash", async () => {
    const [a, b] = await Promise.all([hashPassword(pw, cheap), hashPassword(pw, cheap)]);
    expect(a).not.toBe(b);
    expect(a.split("$")[4]).not.toBe(b.split("$")[4]);
    expect(await verifyPassword(pw, a)).toBe(true);
    expect(await verifyPassword(pw, b)).toBe(true);
  });

  it("reads the params from the encoded string", async () => {
    const salt = Buffer.alloc(16, 7);
    const hash = scryptSync(pw, salt, 32, { N: 2 ** 9, r: 4, p: 2 });
    const encoded = `scrypt$9$4$2$${salt.toString("base64url")}$${hash.toString("base64url")}`;
    expect(await verifyPassword(pw, encoded)).toBe(true);
    expect(await verifyPassword(pw, encoded.replace("scrypt$9$4$2$", "scrypt$10$4$2$"))).toBe(false);
    expect(await verifyPassword(pw, encoded.replace("scrypt$9$4$2$", "scrypt$9$4$1$"))).toBe(false);
  });

  it("returns false for malformed or tampered encodings without throwing", async () => {
    const encoded = await hashPassword(pw, cheap);
    const [, , , , salt, hash] = encoded.split("$");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    const bad = [
      "",
      "scrypt",
      "not-a-hash",
      encoded.replace(/^scrypt/, "bcrypt"),
      `${encoded}$extra`,
      encoded.split("$").slice(0, 5).join("$"),
      `scrypt$10$8$1$${flip(salt)}$${hash}`, // tampered salt
      `scrypt$10$8$1$${salt}$${flip(hash)}`, // tampered hash
      `scrypt$10$8$1$${salt}$${hash.slice(0, -4)}`, // truncated hash
      `scrypt$10$8$1$${salt}$${hash}=`, // padding / non-canonical
      `scrypt$10$8$1$${salt}$${hash.slice(0, -1)}+`, // non-base64url char
      `scrypt$10$8$1$$${hash}`, // empty salt
      `scrypt$010$8$1$${salt}$${hash}`, // leading zero
      `scrypt$1e1$8$1$${salt}$${hash}`,
      `scrypt$-10$8$1$${salt}$${hash}`,
      `scrypt$0$8$1$${salt}$${hash}`,
      `scrypt$10.0$8$1$${salt}$${hash}`,
      // absurd params must be rejected up front, not computed
      `scrypt$40$8$1$${salt}$${hash}`,
      `scrypt$21$1$1$${salt}$${hash}`,
      `scrypt$10$100000$1$${salt}$${hash}`,
      `scrypt$10$8$100000$${salt}$${hash}`,
      `scrypt$18$16$16$${salt}$${hash}`,
    ];
    for (const e of bad) expect(await verifyPassword(pw, e), e).toBe(false);
    expect(await verifyPassword(pw, undefined as unknown as string)).toBe(false);
    expect(await verifyPassword(pw, 42 as unknown as string)).toBe(false);
    expect(await verifyPassword(null as unknown as string, encoded)).toBe(false);
  });

  it("rejects invalid params when hashing", async () => {
    await expect(hashPassword(pw, { log2N: 30 })).rejects.toThrow(/Invalid scrypt parameters/);
    await expect(hashPassword(pw, { r: 0 })).rejects.toThrow(/Invalid scrypt parameters/);
  });

  it("uses N=2^17, r=8, p=1, a 16-byte salt and a 64-byte key by default", async () => {
    const encoded = await hashPassword(pw);
    const [scheme, log2N, r, p, salt, hash] = encoded.split("$");
    expect([scheme, log2N, r, p]).toEqual(["scrypt", "17", "8", "1"]);
    expect(Buffer.from(salt, "base64url")).toHaveLength(16);
    expect(Buffer.from(hash, "base64url")).toHaveLength(64);
    expect(await verifyPassword(pw, encoded)).toBe(true);
  });
});

describe("getDummyHash", () => {
  it("is a cached, valid encoding with the production params", async () => {
    const dummy = await getDummyHash();
    expect(dummy).toMatch(/^scrypt\$17\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(await getDummyHash()).toBe(dummy);
    expect(await verifyPassword(pw, dummy)).toBe(false);
  });
});

describe("validatePassword", () => {
  it("enforces 10–256 characters", () => {
    expect(validatePassword("short")).toMatch(/at least 10/);
    expect(validatePassword("a".repeat(9))).toMatch(/at least 10/);
    expect(validatePassword("a".repeat(10))).toBeNull();
    expect(validatePassword("a".repeat(256))).toBeNull();
    expect(validatePassword("a".repeat(257))).toMatch(/at most 256/);
    expect(validatePassword("a".repeat(100_000))).toMatch(/at most 256/);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(validatePassword("😀".repeat(9))).toMatch(/at least 10/);
    expect(validatePassword("😀".repeat(256))).toBeNull();
  });

  it("rejects the email as password, case-insensitively", () => {
    expect(validatePassword("Me@Example.com", "me@example.com")).toMatch(/same as the email/);
    expect(validatePassword("me@example.com", " ME@EXAMPLE.COM ")).toMatch(/same as the email/);
    expect(validatePassword("me@example.com!", "me@example.com")).toBeNull();
  });

  it("accepts a reasonable password", () => {
    expect(validatePassword(pw, "me@example.com")).toBeNull();
    expect(validatePassword(pw)).toBeNull();
  });
});
