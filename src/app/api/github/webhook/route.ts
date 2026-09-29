import { NextResponse } from "next/server";
import {
  EVENT_HEADER,
  SIGNATURE_HEADER,
  applyWebhookEvent,
  isHandledEvent,
  verifySignature,
  webhookKeys,
  webhookRepo,
} from "@/lib/github/webhook";
import { getGithubSnapshot, githubRepoAccess, upsertGithubSnapshot } from "@/lib/repo";

// POST from a repo webhook (set up by hand; content type application/json). GitHub sends no session or API key, so
// src/proxy.ts lets exactly this path through and the HMAC signature (X-Hub-Signature-256, GITHUB_WEBHOOK_SECRET) is
// the auth. It never calls GitHub: the delivery is written straight into the snapshots.
// - 401: unsigned, a bad signature, or GITHUB_WEBHOOK_SECRET not set. One answer for all three, so a caller can't
//   tell whether a secret is configured (a 503 would say so); the missing secret is logged on the server instead.
// - 400: a validly signed body that isn't JSON (e.g. the webhook set to application/x-www-form-urlencoded).
// - 204: everything else. `ping`, unhandled events, and repos not linked to a personal project (unlinked, or company
//   only) are acknowledged with nothing stored.

let warnedNoSecret = false;

const noContent = () => new Response(null, { status: 204 });

export async function POST(request: Request) {
  // The raw bytes, read once: the signature is over them exactly, and JSON is parsed from the same bytes.
  const body = new Uint8Array(await request.arrayBuffer());
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret && !warnedNoSecret) {
    warnedNoSecret = true;
    console.warn("GitHub webhook: GITHUB_WEBHOOK_SECRET isn't set, so every delivery is refused with 401.");
  }
  if (!verifySignature(body, request.headers.get(SIGNATURE_HEADER), secret)) {
    return NextResponse.json(
      { error: "unauthorized", message: `Missing or invalid ${SIGNATURE_HEADER}.` },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return NextResponse.json(
      { error: "invalid_input", message: "The body isn't JSON. Set the webhook's content type to application/json." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const event = request.headers.get(EVENT_HEADER);
  if (!isHandledEvent(event)) return noContent();
  const repo = webhookRepo(payload);
  // Checked on every delivery, as the pull path does: company and unlinked repos store nothing.
  if (!repo || !(await githubRepoAccess(repo)).allowed) return noContent();

  const now = new Date();
  for (const key of webhookKeys(event, payload)) {
    const next = applyWebhookEvent(key, await getGithubSnapshot(key), event, payload, now);
    if (next) await upsertGithubSnapshot(next);
  }
  return noContent();
}
