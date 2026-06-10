"use client";

import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface StoreItem {
  slug: string;
  title: string;
  description: string;
  priceCents: number;
  currency: string;
}

export default function StorePage() {
  const [items, setItems] = useState<StoreItem[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/api/v1/store/items`, { cache: "no-store" })
      .then((r) => r.json())
      .then(setItems)
      .catch(() => setErr("Cannot reach the Hub API."));
  }, []);

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-1">Page Store</h1>
      <p className="text-sm text-[var(--ccp-muted)] mb-5">
        Extra pages your customers can buy. Purchases grant over-the-air to their
        displays (Stripe checkout from the mobile app).
      </p>
      {err && <div className="card p-4 text-sm text-[var(--ccp-red)]">{err}</div>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => (
          <div key={it.slug} className="card p-4 flex flex-col gap-2">
            <div className="font-semibold">{it.title}</div>
            <div className="text-sm text-[var(--ccp-muted)] flex-1">
              {it.description}
            </div>
            <div className="text-[var(--ccp-accent)] font-bold">
              {it.priceCents === 0
                ? "Free"
                : `$${(it.priceCents / 100).toFixed(2)}`}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
