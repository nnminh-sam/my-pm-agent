import { cookies } from "next/headers";
import Link from "next/link";
import Script from "next/script";
import { logout } from "@/app/actions";
import { SESSION_COOKIE, authMode, authenticate } from "@/lib/auth";

const NAV = [
  { href: "/", label: "Schedule" },
  { href: "/projects", label: "Projects" },
  { href: "/backlog", label: "Backlog" },
  { href: "/gantt", label: "Gantt" },
  { href: "/connect", label: "Connect" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const jwt = authMode() === "jwt";
  const session = jwt ? authenticate({ sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value }) : null;
  const email = session && session !== "agent" ? session.email : null;

  return (
    <>
      <header className="border-b border-border bg-surface">
        <nav className="mx-auto flex max-w-5xl items-center gap-0.5 overflow-x-auto px-3 sm:px-4 py-2.5 text-sm whitespace-nowrap sm:gap-4">
          <Link href="/" className="mr-1 font-semibold tracking-tight sm:mr-2">
            my_pm
          </Link>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="rounded px-2 py-1 text-muted hover:bg-bg hover:text-fg">
              {item.label}
            </Link>
          ))}
          {jwt && (
            <form action={logout} className="ml-auto flex items-center gap-2">
              {email && (
                <span className="max-w-48 truncate text-xs text-muted" title={email}>
                  {email}
                </span>
              )}
              <button className="rounded px-2 py-1 text-muted hover:bg-bg hover:text-fg">Log out</button>
            </form>
          )}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:py-8">{children}</main>
      {/* Registers read/update tools with in-browser agents (WebMCP). No-op in browsers without navigator.modelContext. */}
      <Script src="/api/mcp?webmcp-script" strategy="afterInteractive" />
    </>
  );
}
