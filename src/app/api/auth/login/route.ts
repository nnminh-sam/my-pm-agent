import type { NextRequest } from "next/server";
import { invalidBody, readCredentials, requireJwtMode, sessionResponse } from "@/lib/auth/http";
import { logIn } from "@/lib/auth/users";

// POST { email, password } → 200 { token, expires_at, user }; 400 / 401 otherwise.
export async function POST(request: NextRequest) {
  const disabled = requireJwtMode();
  if (disabled) return disabled;
  const body = await readCredentials(request);
  if (!body) return invalidBody();
  return sessionResponse(request, await logIn({ email: body.email, password: body.password }), 200);
}
