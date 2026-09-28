import type { NextRequest } from "next/server";
import { logoutResponse } from "@/lib/auth/http";

// POST → 200 { ok: true } and clears the session cookie. Sessions are stateless, so there's nothing to revoke.
export async function POST(request: NextRequest) {
  return logoutResponse(request);
}
