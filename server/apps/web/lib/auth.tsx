"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SB_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface Me {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isAdmin: boolean;
  entitlements: { slug: string; title: string }[];
}

interface AuthCtx {
  token: string | null;
  me: Me | null;
  loading: boolean;
  requestOtp: (email: string) => Promise<string | null>;
  verifyOtp: (email: string, code: string) => Promise<boolean>;
  signOut: () => void;
}

const Ctx = createContext<AuthCtx>(null as never);
export const useAuth = () => useContext(Ctx);

/** Authenticated fetch against the Hub API. */
export async function api(path: string, token: string | null, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = localStorage.getItem("ccp_token");
    if (!t) {
      setLoading(false);
      return;
    }
    setToken(t);
    api("/api/v1/auth/me", t)
      .then((m) => setMe(m))
      .catch(() => localStorage.removeItem("ccp_token"))
      .finally(() => setLoading(false));
  }, []);

  const requestOtp = async (email: string): Promise<string | null> => {
    const res = await fetch(`${SB_URL}/auth/v1/otp`, {
      method: "POST",
      headers: { apikey: SB_ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, create_user: true }),
    });
    if (!res.ok) return (await res.json()).msg ?? "failed to send code";
    return null;
  };

  const verifyOtp = async (email: string, code: string): Promise<boolean> => {
    const res = await fetch(`${SB_URL}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: SB_ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "email", email, token: code }),
    });
    if (!res.ok) return false;
    const json = await res.json();
    const t = json.access_token as string;
    localStorage.setItem("ccp_token", t);
    setToken(t);
    const m = await api("/api/v1/auth/me", t);
    setMe(m);
    return true;
  };

  const signOut = () => {
    localStorage.removeItem("ccp_token");
    setToken(null);
    setMe(null);
  };

  return (
    <Ctx.Provider value={{ token, me, loading, requestOtp, verifyOtp, signOut }}>
      {children}
    </Ctx.Provider>
  );
}
