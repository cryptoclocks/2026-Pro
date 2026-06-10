"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { requestOtp, verifyOtp } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setErr(null);
    const e = await requestOtp(email.trim());
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
          Admin & user console. We&apos;ll email you a 6-digit code.
        </p>
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
          {busy ? "Please wait…" : sent ? "Verify & sign in" : "Send code"}
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
