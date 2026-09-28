import type { NextRequest } from "next/server";
import { invalidBody, readCredentials, requireJwtMode, sessionResponse } from "@/lib/auth/http";
import { signUp } from "@/lib/auth/users";

// POST { email, password, confirm? } → 201 { token, expires_at, user }; 400 / 403 / 409 otherwise.
export async function POST(request: NextRequest) {
  const disabled = requireJwtMode();
  if (disabled) return disabled;
  const body = await readCredentials(request);
  if (!body) return invalidBody();
  return sessionResponse(request, await signUp({ email: body.email, password: body.password, confirm: body.confirm }), 201);
}
