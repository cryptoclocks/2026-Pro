"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminGate } from "@/components/AdminGate";
import { api, useAuth } from "@/lib/auth";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  devices: number;
  purchases: number;
}
interface Detail {
  id: string;
  email: string;
  entitlements: { item: { slug: string; title: string }; source: string }[];
  devices: { deviceId: string; name: string | null; online: boolean }[];
  featureRequests: { page: string; feature: string; status: string }[];
}

export default function UsersPage() {
  return (
    <AdminGate>
      <Users />
    </AdminGate>
  );
}

function Users() {
  const { token } = useAuth();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [open, setOpen] = useState<Detail | null>(null);
  const [catalog, setCatalog] = useState<string[]>([]);

  const load = useCallback(() => {
    api("/api/v1/admin/users", token).then(setRows).catch(() => {});
    api("/api/v1/store/items", token)
      .then((items: { slug: string }[]) => setCatalog(items.map((i) => i.slug)))
      .catch(() => {});
  }, [token]);

  useEffect(load, [load]);

  const openDetail = async (id: string) =>
    setOpen(await api(`/api/v1/admin/users/${id}`, token));

  const grant = async (slug: string) => {
    if (!open) return;
    await api(`/api/v1/admin/users/${open.id}/grant`, token, {
      method: "POST",
      body: JSON.stringify({ slug }),
    });
    await openDetail(open.id);
    load();
  };
  const revoke = async (slug: string) => {
    if (!open) return;
    await api(`/api/v1/admin/users/${open.id}/revoke`, token, {
      method: "POST",
      body: JSON.stringify({ slug }),
    });
    await openDetail(open.id);
    load();
  };

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-1">Users</h1>
      <p className="text-sm text-[var(--ccp-muted)] mb-5">
        Everyone who signed in. Click a user to see purchases, devices, and grant
        or revoke pages.
      </p>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-[var(--ccp-muted)] text-left">
            <tr className="border-b border-[var(--ccp-border)]">
              <th className="p-3">Email</th>
              <th className="p-3">Role</th>
              <th className="p-3">Devices</th>
              <th className="p-3">Purchases</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr
                key={u.id}
                className="border-b border-[var(--ccp-border)] hover:bg-[var(--ccp-panel-2)] cursor-pointer"
                onClick={() => openDetail(u.id)}
              >
                <td className="p-3">{u.email}</td>
                <td className="p-3">
                  {u.role === "ADMIN" || u.role === "SUPER_ADMIN" ? (
                    <span className="pill">{u.role}</span>
                  ) : (
                    u.role
                  )}
                </td>
                <td className="p-3">{u.devices}</td>
                <td className="p-3">{u.purchases}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="p-4 text-[var(--ccp-muted)]" colSpan={4}>
                  No users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setOpen(null)}
        >
          <div className="card w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-3">{open.email}</h2>

            <Section title="Pages owned">
              {open.entitlements.length === 0 ? (
                <Empty>none</Empty>
              ) : (
                open.entitlements.map((e) => (
                  <div key={e.item.slug} className="flex items-center gap-2 py-1">
                    <span className="flex-1">{e.item.title}</span>
                    <span className="pill">{e.source}</span>
                    <button className="btn btn-danger" onClick={() => revoke(e.item.slug)}>
                      Revoke
                    </button>
                  </div>
                ))
              )}
              <div className="flex gap-2 mt-2 flex-wrap">
                {catalog
                  .filter((s) => !open.entitlements.some((e) => e.item.slug === s))
                  .map((s) => (
                    <button key={s} className="btn" onClick={() => grant(s)}>
                      + grant {s}
                    </button>
                  ))}
              </div>
            </Section>

            <Section title="Devices">
              {open.devices.length === 0 ? (
                <Empty>none</Empty>
              ) : (
                open.devices.map((d) => (
                  <div key={d.deviceId} className="flex items-center gap-2 py-1">
                    <span
                      className="dot"
                      style={{ background: d.online ? "var(--ccp-green)" : "var(--ccp-muted)" }}
                    />
                    <span>{d.name ?? d.deviceId}</span>
                    <span className="text-[var(--ccp-muted)] font-mono text-xs">
                      {d.deviceId}
                    </span>
                  </div>
                ))
              )}
            </Section>

            <Section title="Feature requests">
              {open.featureRequests.length === 0 ? (
                <Empty>none</Empty>
              ) : (
                open.featureRequests.map((f, i) => (
                  <div key={i} className="flex gap-2 py-1">
                    <span className="flex-1">
                      {f.page} · {f.feature}
                    </span>
                    <span className="pill">{f.status}</span>
                  </div>
                ))
              )}
            </Section>

            <button className="btn w-full justify-center mt-3" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-xs uppercase tracking-wide text-[var(--ccp-muted)] mb-1">
        {title}
      </div>
      {children}
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-[var(--ccp-muted)]">{children}</div>;
}
