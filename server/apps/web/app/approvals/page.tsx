"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminGate } from "@/components/AdminGate";
import { api, useAuth } from "@/lib/auth";

interface Req {
  id: string;
  deviceId: string;
  page: string;
  feature: string;
  detail: Record<string, unknown>;
  status: string;
  createdAt: string;
  user: { email: string; name: string | null };
}

export default function ApprovalsPage() {
  return (
    <AdminGate>
      <Approvals />
    </AdminGate>
  );
}

function Approvals() {
  const { token } = useAuth();
  const [reqs, setReqs] = useState<Req[]>([]);
  const [filter, setFilter] = useState<"PENDING" | "APPROVED" | "REJECTED">("PENDING");

  const load = useCallback(() => {
    api(`/api/v1/admin/feature-requests?status=${filter}`, token)
      .then(setReqs)
      .catch(() => {});
  }, [token, filter]);

  useEffect(load, [load]);

  const decide = async (id: string, action: "approve" | "reject") => {
    await api(`/api/v1/admin/feature-requests/${id}/${action}`, token, { method: "POST" });
    load();
  };

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-1">Feature approvals</h1>
      <p className="text-sm text-[var(--ccp-muted)] mb-4">
        Optional per-page features (e.g. crypto price alerts) wait here for manual
        approval. Approving pushes the feature to the user&apos;s display.
      </p>
      <div className="flex gap-2 mb-4">
        {(["PENDING", "APPROVED", "REJECTED"] as const).map((f) => (
          <button
            key={f}
            className="btn"
            style={filter === f ? { borderColor: "var(--ccp-accent)", color: "var(--ccp-accent)" } : {}}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="grid gap-3">
        {reqs.map((r) => (
          <div key={r.id} className="card p-4 flex items-center gap-3">
            <div className="flex-1">
              <div className="font-semibold">
                {r.page} · {r.feature}
              </div>
              <div className="text-xs text-[var(--ccp-muted)]">
                {r.user.email} → {r.deviceId}
              </div>
              <pre className="text-[11px] text-[var(--ccp-muted)] mt-1 max-w-xl overflow-x-auto">
                {JSON.stringify(r.detail)}
              </pre>
            </div>
            {r.status === "PENDING" ? (
              <div className="flex gap-2">
                <button className="btn btn-primary" onClick={() => decide(r.id, "approve")}>
                  Approve
                </button>
                <button className="btn btn-danger" onClick={() => decide(r.id, "reject")}>
                  Reject
                </button>
              </div>
            ) : (
              <span className="pill">{r.status}</span>
            )}
          </div>
        ))}
        {reqs.length === 0 && (
          <div className="card p-6 text-sm text-[var(--ccp-muted)] text-center">
            No {filter.toLowerCase()} requests.
          </div>
        )}
      </div>
    </main>
  );
}
