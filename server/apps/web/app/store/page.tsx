"use client";

import { useCallback, useEffect, useState } from "react";
import { api, useAuth } from "@/lib/auth";

interface StoreItem {
  slug: string;
  title: string;
  description: string;
  priceCents: number;
  currency: string;
  kind: string;
}
interface ManagedItem {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  priceCents: number;
  currency: string;
  kind: string;
  published: boolean;
}

export default function StorePage() {
  const { token, me } = useAuth();
  const [items, setItems] = useState<StoreItem[]>([]);
  const [managed, setManaged] = useState<ManagedItem[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api("/api/v1/store/items", token).then(setItems).catch(() => setErr("Cannot reach the Hub API."));
    if (me?.isAdmin) {
      api("/api/v1/store/admin/items", token)
        .then((r: ManagedItem[] | { managed: ManagedItem[] }) => setManaged(Array.isArray(r) ? r : r.managed))
        .catch(() => {});
    }
  }, [token, me]);

  useEffect(load, [load]);

  const patch = async (id: string, body: Partial<ManagedItem>) => {
    await api(`/api/v1/store/admin/items/${id}`, token, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    load();
  };

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-1">Page Store</h1>
      <p className="text-sm text-[var(--ccp-muted)] mb-5">
        Extra pages customers can buy. Purchases grant over-the-air to their displays.
      </p>
      {err && <div className="card p-4 text-sm text-[var(--ccp-red)] mb-4">{err}</div>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-8">
        {items.map((it) => (
          <div key={it.slug} className="card p-4 flex flex-col gap-2">
            <div className="font-semibold">{it.title}</div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--ccp-muted)]">{it.kind}</div>
            <div className="text-sm text-[var(--ccp-muted)] flex-1">{it.description}</div>
            <div className="text-[var(--ccp-accent)] font-bold">
              {formatMoney(it.priceCents, it.currency)}
            </div>
          </div>
        ))}
      </div>

      {me?.isAdmin && (
        <section>
          <h2 className="text-lg font-semibold mb-2">Manage published pages</h2>
          {managed.length === 0 ? (
            <div className="card p-5 text-sm text-[var(--ccp-muted)]">
              No published pages yet. Publish a layout from the Builder to create a
              sellable page, then set its price and publish flag here.
            </div>
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="text-[var(--ccp-muted)] text-left">
                  <tr className="border-b border-[var(--ccp-border)]">
                    <th className="p-3">Page</th>
                    <th className="p-3">Kind</th>
                    <th className="p-3">Price</th>
                    <th className="p-3">Published</th>
                  </tr>
                </thead>
                <tbody>
                  {managed.map((m) => (
                    <tr key={m.id} className="border-b border-[var(--ccp-border)]">
                      <td className="p-3">{m.title}</td>
                      <td className="p-3"><span className="pill">{m.kind}</span></td>
                      <td className="p-3">
                        <input
                          className="input w-24"
                          type="number"
                          defaultValue={minorToMajor(m.priceCents)}
                          onBlur={(e) => patch(m.id, { priceCents: majorToMinor(Number(e.target.value)) })}
                        />
                        <span className="ml-2 text-xs text-[var(--ccp-muted)]">{m.currency.toUpperCase()}</span>
                      </td>
                      <td className="p-3">
                        <button
                          className="btn"
                          onClick={() => patch(m.id, { published: !m.published })}
                        >
                          {m.published ? "Published" : "Draft"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function formatMoney(minor: number, currency: string) {
  if (minor === 0) return "Free";
  return new Intl.NumberFormat(currency.toLowerCase() === "thb" ? "th-TH" : "en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(minorToMajor(minor));
}

function minorToMajor(value: number) {
  return Number((value / 100).toFixed(2));
}

function majorToMinor(value: number) {
  return Math.round(value * 100);
}
