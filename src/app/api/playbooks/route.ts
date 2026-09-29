import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, isAuthorized } from "@/lib/auth";
import { jsonError } from "@/lib/auth/http";
import { ConflictError, syncPlaybook } from "@/lib/repo";

// POST <compiled playbook as JSON> → 201 { ref, hash, synced_at, created: true } for a new version, 200 with
// created: false when that exact version is already stored; 400 invalid_input, 409 version_changed (different
// content under a stored version: release it as a new one). pm-flow calls this from the playbooks repo on commit.
export async function POST(request: NextRequest) {
  // proxy.ts already checks auth; this guards the endpoint if the matcher ever changes (as /api/mcp does).
  const credentials = { authorization: request.headers.get("authorization"), sessionCookie: request.cookies.get(SESSION_COOKIE)?.value };
  if (!(await isAuthorized(credentials))) {
    return NextResponse.json(
      { error: "unauthorized", message: "Send Authorization: Bearer <API key>." },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="pm"' } },
    );
  }
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return jsonError(400, "invalid_input", "Send the compiled playbook as a JSON body (Content-Type: application/json).");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_input", "The body isn't valid JSON.");
  }
  try {
    const { version, created } = await syncPlaybook(body);
    return NextResponse.json(
      { ref: version.ref, hash: version.hash, synced_at: version.synced_at, created },
      { status: created ? 201 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof z.ZodError) return jsonError(400, "invalid_input", z.prettifyError(err));
    if (err instanceof ConflictError) return jsonError(409, "version_changed", err.message);
    throw err;
  }
}

export const dynamic = "force-dynamic";
