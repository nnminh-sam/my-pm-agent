import Link from "next/link";
import { login } from "@/app/actions";
import { AuthCard, ErrorMessage, Field, ModeNotice, SubmitButton } from "@/components/auth-form";
import { authMode, safeNext } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const mode = authMode();
  const back = safeNext(next);

  return (
    <AuthCard title="Log in to my_pm">
      {mode !== "jwt" ? (
        <ModeNotice mode={mode} />
      ) : (
        <>
          <form action={login} className="mt-4 space-y-3">
            <input type="hidden" name="next" value={back} />
            <Field name="email" label="Email" type="email" required autoFocus autoComplete="email" />
            <Field name="password" label="Password" type="password" required autoComplete="current-password" />
            <ErrorMessage code={error} />
            <SubmitButton>Log in</SubmitButton>
          </form>
          <p className="mt-4 text-sm text-muted">
            No account?{" "}
            <Link href={`/signup?next=${encodeURIComponent(back)}`} className="text-accent underline">
              Sign up
            </Link>
          </p>
        </>
      )}
    </AuthCard>
  );
}
