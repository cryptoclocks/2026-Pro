"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { requestLoginLink, verifyOtp, hashError, me } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // already signed in (e.g. link captured by AuthProvider) -> go home
  useEffect(() => {
    if (me) router.push("/");
  }, [me, router]);

  const send = async () => {
    setBusy(true);
    setErr(null);
    const e = await requestLoginLink(email.trim());
    setBusy(false);
    if (e) setErr(e);
    else setSent(true);
  };

  const verify = async () => {
    setBusy(true);
    setErr(null);
    const ok = await verifyOtp(email.trim(), code.trim());
    setBusy(false);
    if (ok) router.push("/");
    else setErr("Wrong or expired code");
  };

  return (
    <main className="min-h-[80vh] flex items-center justify-center p-6">
      <div className="card p-7 w-full max-w-sm">
        <h1 className="text-xl font-semibold mb-1">Sign in</h1>
        <p className="text-sm text-[var(--ccp-muted)] mb-5">
          Admin & user console. We&apos;ll email you a sign-in link.
        </p>
        {hashError && (
          <div className="text-[var(--ccp-red)] text-sm mb-3 border border-[var(--ccp-red)]/40 rounded p-2">
            {hashError}. Sign-in links are single-use and expire — request a fresh
            one below and click it once.
          </div>
        )}
        <label className="block text-xs text-[var(--ccp-muted)] mb-1">Email</label>
        <input
          className="input w-full mb-3"
          value={email}
          disabled={sent}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        {sent && (
          <>
            <p className="text-xs text-[var(--ccp-muted)] mb-3">
              Open the sign-in link from your email. If your Supabase email
              template includes a numeric token, you can enter it below.
            </p>
            <label className="block text-xs text-[var(--ccp-muted)] mb-1">Code</label>
            <input
              className="input w-full mb-3"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
            />
          </>
        )}
        {err && <div className="text-[var(--ccp-red)] text-sm mb-3">{err}</div>}
        <button
          className="btn btn-primary w-full justify-center"
          disabled={busy}
          onClick={sent ? verify : send}
        >
          {busy ? "Please wait…" : sent ? "Verify code" : "Send sign-in link"}
        </button>
        {sent && (
          <button
            className="text-xs text-[var(--ccp-muted)] mt-3 w-full text-center"
            onClick={() => setSent(false)}
          >
            Use a different email
          </button>
        )}
      </div>
    </main>
  );
}
