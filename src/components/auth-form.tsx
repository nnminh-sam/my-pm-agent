import Link from "next/link";
import { lockedMessage, type AuthMode } from "@/lib/auth";
import { AUTH_ERROR_MESSAGES, type AuthError } from "@/lib/auth/users";

/** Shared pieces of the /login and /signup pages. */

export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** What to show instead of a form when accounts are off ("open") or unconfigured ("locked"). */
export function ModeNotice({ mode }: { mode: Exclude<AuthMode, "jwt"> }) {
  if (mode === "open") {
    return (
      <p className="mt-3 text-sm text-muted">
        Auth is off because JWT_SECRET isn&apos;t set. <Link href="/" className="text-accent underline">Open the app</Link>.
      </p>
    );
  }
  return <p className="mt-3 text-sm text-danger">{lockedMessage()}</p>;
}

export function ErrorMessage({ code }: { code?: string }) {
  if (!code) return null;
  const message = AUTH_ERROR_MESSAGES[code as AuthError] ?? "Something went wrong. Try again.";
  return (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}

export function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { name: string; label: string }) {
  const { label, ...input } = props;
  return (
    <input
      {...input}
      aria-label={label}
      placeholder={label}
      className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm"
    />
  );
}

export function SubmitButton({ children }: { children: React.ReactNode }) {
  return (
    <button className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white dark:text-black">{children}</button>
  );
}
