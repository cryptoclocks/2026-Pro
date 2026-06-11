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
  hashError: string | null;
  requestLoginLink: (email: string) => Promise<string | null>;
  signInWithGoogle: () => void;
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
  const [hashError, setHashError] = useState<string | null>(null);

  useEffect(() => {
    const urlErr = readSupabaseErrorFromUrl();
    if (urlErr) {
      setHashError(urlErr);
      window.history.replaceState({}, document.title, window.location.pathname);
      setLoading(false);
      return;
    }

    const fromUrl = readSupabaseTokenFromUrl();
    if (fromUrl) {
      localStorage.setItem("ccp_token", fromUrl);
      window.history.replaceState({}, document.title, window.location.pathname);
      setToken(fromUrl);
      api("/api/v1/auth/me", fromUrl)
        .then((m) => setMe(m))
        .catch(() => localStorage.removeItem("ccp_token"))
        .finally(() => setLoading(false));
      return;
    }

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

  const requestLoginLink = async (email: string): Promise<string | null> => {
    const redirectTo =
      typeof window === "undefined" ? undefined : `${window.location.origin}/login`;
    const url = new URL(`${SB_URL}/auth/v1/otp`);
    if (redirectTo) url.searchParams.set("redirect_to", redirectTo);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { apikey: SB_ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, create_user: true }),
    });
    if (!res.ok) return (await res.json()).msg ?? "failed to send sign-in link";
    return null;
  };

  const requestOtp = requestLoginLink;

  const signInWithGoogle = () => {
    const redirectTo =
      typeof window === "undefined" ? undefined : `${window.location.origin}/login`;
    const url = new URL(`${SB_URL}/auth/v1/authorize`);
    url.searchParams.set("provider", "google");
    if (redirectTo) url.searchParams.set("redirect_to", redirectTo);
    window.location.assign(url.toString());
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
    <Ctx.Provider value={{ token, me, loading, hashError, requestLoginLink, signInWithGoogle, requestOtp, verifyOtp, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

function readSupabaseTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  return hash.get("access_token") ?? query.get("access_token");
}

function readSupabaseErrorFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const err = hash.get("error") ?? query.get("error");
  if (!err) return null;
  const desc = hash.get("error_description") ?? query.get("error_description");
  return (desc ?? err).replace(/\+/g, " ");
}
