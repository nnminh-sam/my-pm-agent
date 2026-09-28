import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  authMode,
  authenticate,
  authenticateRequest,
  bearerToken,
  clearedSessionCookieOptions,
  isSecureRequest,
  lockedMessage,
  renewSession,
  safeNext,
  sessionCookieOptions,
} from "@/lib/auth";

// Pages anyone may open (their forms and the /api/auth routes check the auth mode themselves).
const AUTH_PAGES = new Set(["/login", "/signup"]);

function deny(request: NextRequest, message: string, clearCookie: boolean) {
  const secure = isSecureRequest(request.headers.get("x-forwarded-proto"));
  let response: NextResponse;
  if (request.nextUrl.pathname.startsWith("/api/")) {
    response = NextResponse.json(
      { error: "unauthorized", message },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="pm"' } },
    );
  } else {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    response = NextResponse.redirect(login);
  }
  // Drop an expired or tampered session cookie so the browser stops sending it.
  if (clearCookie) response.cookies.set(SESSION_COOKIE, "", clearedSessionCookieOptions(secure));
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const mode = authMode();
  if (mode === "open") return NextResponse.next();

  const isAuthPage = AUTH_PAGES.has(pathname);
  if (mode === "locked") {
    // The login page explains the lock; everything else is refused.
    if (isAuthPage) return NextResponse.next();
    return deny(request, lockedMessage(), false);
  }

  if (pathname.startsWith("/api/auth/")) return NextResponse.next();

  const authorization = request.headers.get("authorization");
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;

  if (isAuthPage) {
    // Already signed in: skip the form (GET only, so a form POST still reaches its server action).
    // Not for "agent" (API key or PM_SECRET), which has no session to continue with, so the synchronous
    // check suffices here and an API key costs no lookup.
    const session = authenticate({ authorization, sessionCookie: cookie });
    if (session && session !== "agent" && request.method === "GET") {
      return NextResponse.redirect(new URL(safeNext(request.nextUrl.searchParams.get("next")), request.url));
    }
    return NextResponse.next();
  }

  // Async only for a pm_ API key (a DB lookup); JWTs and PM_SECRET are checked in memory.
  const auth = await authenticateRequest({ authorization, sessionCookie: cookie });

  if (!auth) {
    const message = "Log in, or send Authorization: Bearer <token> (a session JWT, an API key (npm run auth:create-key) or PM_SECRET).";
    return deny(request, message, Boolean(cookie) && !bearerToken(authorization));
  }

  const response = NextResponse.next();
  // Sliding renewal of cookie sessions only: never for agents, and not when a Bearer header decided.
  if (auth !== "agent" && !bearerToken(authorization)) {
    const renewed = renewSession(auth);
    if (renewed) {
      const secure = isSecureRequest(request.headers.get("x-forwarded-proto"));
      response.cookies.set(SESSION_COOKIE, renewed.token, sessionCookieOptions(secure));
    }
  }
  return response;
}

export const config = {
  // Everything except Next's static files and public assets (images, fonts, robots.txt, sitemap.xml).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:ico|png|jpg|jpeg|gif|svg|webp|avif|woff2?)$).*)",
  ],
};
