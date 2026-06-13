"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminGate } from "@/components/AdminGate";
import { api, useAuth } from "@/lib/auth";
import { SchemaForm, withDefaults, type SettingsField, type SettingsValues } from "@/components/SchemaForm";

interface Ent { slug: string; title: string; kind: string; source: string }
interface Device {
  id: string;
  deviceId: string;
  name: string | null;
  online: boolean;
  ip: string | null;
  rssi: number | null;
  battMv: number | null;
  fps: number | null;
  fwVersion: string | null;
  locked: boolean;
  settings: Record<string, unknown>;
  settingsVersion: number;
  owner?: { email: string; name: string | null } | null;
  entitlements?: Ent[];
  activePayloadVersion?: {
    layout?: { meta?: { id?: string; name?: string }; settings_schema?: SettingsField[] };
  } | null;
}

/** Active package's settings form, if it declares one. slug = id after last dot
    (com.ccp.weather → weather), matching settings.pages / settings.<slug>. */
function activePageSettings(d: Device): { slug: string; name: string; schema: SettingsField[] } | null {
  const layout = d.activePayloadVersion?.layout;
  const schema = layout?.settings_schema;
  const id = layout?.meta?.id;
  if (!schema?.length || !id) return null;
  return { slug: id.split(".").pop() || id, name: layout?.meta?.name || id, schema };
}
interface CatalogItem { slug: string; title: string; kind: string; priceCents: number; currency: string; published?: boolean }

export default function FleetPage() {
  return (
    <AdminGate>
      <Fleet />
    </AdminGate>
  );
}

function Fleet() {
  const { token, me } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Device | null>(null);
  const [rights, setRights] = useState<Device | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const json = await api("/api/v1/devices", token);
      setDevices(Array.isArray(json) ? json : []);
      setErr(null);
    } catch (e) {
      setDevices([]);
      setErr(e instanceof Error ? e.message : "Cannot reach the Hub API.");
    }
  }, [token]);

  useEffect(() => {
    load();
    api(me?.isAdmin ? "/api/v1/store/admin/items" : "/api/v1/store/items", token)
      .then((r: CatalogItem[] | { managed: CatalogItem[] }) => setCatalog(Array.isArray(r) ? r : r.managed))
      .catch(() => {});
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load, token, me]);

  const online = devices.filter((d) => d.online).length;

  return (
    <main className="p-6">
      <div className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-2xl font-semibold">CryptoClock Devices</h1>
          <p className="text-sm text-[var(--ccp-muted)]">
            Manage every display: status, owner, settings, commands, and per-device rights.
          </p>
        </div>
        <div className="flex gap-3">
          <Stat label="Devices" value={`${devices.length}`} />
          <Stat label="Online" value={`${online}`} accent />
        </div>
      </div>

      {err && <div className="card p-4 mb-4 text-sm text-[var(--ccp-red)]">{err}</div>}

      {devices.length === 0 && !err ? (
        <div className="card p-8 text-sm text-[var(--ccp-muted)] text-center">
          No devices yet. Flash a CryptoClock Pro display — it appears here when it
          connects to MQTT.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {devices.map((d) => (
            <DeviceCard
              key={d.id}
              d={d}
              onEdit={() => setEditing(d)}
              onRights={() => setRights(d)}
              token={token}
            />
          ))}
        </div>
      )}

      {editing && (
        <SettingsModal device={editing} token={token} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
      {rights && (
        <RightsModal device={rights} catalog={catalog} token={token} onClose={() => setRights(null)} onChanged={load} />
      )}
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card px-4 py-2 text-center">
      <div className="text-xl font-bold" style={{ color: accent ? "var(--ccp-accent)" : "var(--ccp-fg)" }}>{value}</div>
      <div className="text-[11px] text-[var(--ccp-muted)] uppercase tracking-wide">{label}</div>
    </div>
  );
}

function DeviceCard({ d, onEdit, onRights, token }: { d: Device; onEdit: () => void; onRights: () => void; token: string | null }) {
  const pages = (d.settings?.pages as string[] | undefined) ?? [];
  const batt = d.battMv ? `${(d.battMv / 1000).toFixed(2)}V` : "—";
  const cmd = (type: string) =>
    api(`/api/v1/devices/${d.deviceId}/cmd`, token, { method: "POST", body: JSON.stringify({ type }) }).catch(() => {});
  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="dot" style={{ background: d.online ? "var(--ccp-green)" : "var(--ccp-muted)" }} />
        <div className="min-w-0">
          <div className="font-semibold truncate">{d.name ?? d.deviceId}</div>
          <div className="text-[11px] text-[var(--ccp-muted)] font-mono truncate">{d.deviceId}</div>
        </div>
        {d.locked && <span className="pill ml-auto">locked</span>}
      </div>

      <div className="text-xs text-[var(--ccp-muted)]">
        Owner: {d.owner?.email ?? "unclaimed"}
      </div>
      <div className="grid grid-cols-2 gap-y-1 text-xs text-[var(--ccp-muted)]">
        <span>IP {d.ip ?? "—"}</span>
        <span>RSSI {d.rssi ?? "—"} dBm</span>
        <span>Batt {batt}</span>
        <span>FPS {d.fps?.toFixed(0) ?? "—"}</span>
        <span>fw {d.fwVersion ?? "—"}</span>
        <span>cfg v{d.settingsVersion}</span>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wide text-[var(--ccp-muted)] mb-1">Rights</div>
        <div className="flex flex-wrap gap-1">
          {(d.entitlements ?? []).length ? (
            d.entitlements!.map((e) => (
              <span key={e.slug} className="pill" style={{ borderColor: "var(--ccp-accent)", color: "var(--ccp-accent)" }}>
                {e.slug}
              </span>
            ))
          ) : (
            <span className="text-xs text-[var(--ccp-muted)]">built-in pages only</span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {pages.map((p) => <span key={p} className="pill">{p}</span>)}
      </div>

      <div className="flex gap-2 mt-1">
        <button className="btn btn-primary flex-1" onClick={onEdit}>Settings</button>
        <button className="btn" onClick={onRights}>Rights</button>
        <button className="btn" onClick={() => cmd("identify")}>🔔</button>
        <button className="btn" title="Reload UI" onClick={() => cmd("reload")}>↻</button>
      </div>
    </div>
  );
}

function RightsModal({ device, catalog, token, onClose, onChanged }: {
  device: Device; catalog: CatalogItem[]; token: string | null; onClose: () => void; onChanged: () => void;
}) {
  const [owned, setOwned] = useState<string[]>((device.entitlements ?? []).map((e) => e.slug));
  const [busy, setBusy] = useState(false);

  const toggle = async (slug: string, has: boolean) => {
    setBusy(true);
    try {
      await api(`/api/v1/devices/${device.deviceId}/${has ? "revoke" : "grant"}`, token, {
        method: "POST", body: JSON.stringify({ slug }),
      });
      setOwned((cur) => (has ? cur.filter((s) => s !== slug) : [...cur, slug]));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title={`Rights — ${device.name ?? device.deviceId}`}>
      <p className="text-xs text-[var(--ccp-muted)] mb-3">
        Rights attach to this specific CryptoClock. Granting pushes it to the device instantly.
      </p>
      {catalog.map((c) => {
        const has = owned.includes(c.slug);
        return (
          <div key={c.slug} className="flex items-center gap-2 py-1.5 border-b border-[var(--ccp-border)]/40">
            <div className="flex-1">
              <div className="text-sm">{c.title} <span className="pill ml-1">{c.kind}</span></div>
              <div className="text-[11px] text-[var(--ccp-muted)]">
                {c.slug} · {formatMoney(c.priceCents, c.currency)}{c.published === false ? " · draft" : ""}
              </div>
            </div>
            <button className={has ? "btn btn-danger" : "btn btn-primary"} disabled={busy} onClick={() => toggle(c.slug, has)}>
              {has ? "Revoke" : "Grant"}
            </button>
          </div>
        );
      })}
    </Modal>
  );
}

function formatMoney(minor: number, currency: string) {
  if (minor === 0) return "Free";
  return new Intl.NumberFormat(currency.toLowerCase() === "thb" ? "th-TH" : "en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(minor / 100);
}

function SettingsModal({ device, token, onClose, onSaved }: {
  device: Device; token: string | null; onClose: () => void; onSaved: () => void;
}) {
  const s = device.settings ?? {};
  const clock = (s.clock as Record<string, unknown>) ?? {};
  const crypto = (s.crypto as Record<string, unknown>) ?? {};
  const [pages, setPages] = useState<string[]>((s.pages as string[]) ?? ["clock", "crypto", "slideshow"]);
  const [theme, setTheme] = useState<string>((clock.theme as string) ?? "gold");
  const [symbols, setSymbols] = useState<string>(((crypto.symbols as string[]) ?? ["BTCUSDT"]).join(", "));
  const [currency, setCurrency] = useState<string>((crypto.currency as string) ?? "USD");
  const [fetchS, setFetchS] = useState<number>((crypto.fetch_interval_s as number) ?? 10);
  const [busy, setBusy] = useState(false);
  const togglePage = (p: string) => setPages((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  // admin-declared per-page settings form (from the active package's settings_schema)
  const pageSettings = activePageSettings(device);
  const [pageVals, setPageVals] = useState<SettingsValues>(
    pageSettings ? withDefaults(pageSettings.schema, (s[pageSettings.slug] as SettingsValues) ?? {}) : {},
  );

  const save = async () => {
    setBusy(true);
    const config: Record<string, unknown> = {
      ...s, pages, clock: { ...clock, theme },
      crypto: { ...crypto, symbols: symbols.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean), currency, fetch_interval_s: fetchS },
    };
    if (pageSettings) config[pageSettings.slug] = pageVals; // settings.<slug> for the page
    await api(`/api/v1/devices/${device.deviceId}/settings`, token, { method: "PUT", body: JSON.stringify({ config }) });
    setBusy(false);
    onSaved();
  };

  return (
    <Modal onClose={onClose} title={device.name ?? device.deviceId}>
      <p className="text-xs text-[var(--ccp-muted)] mb-4">Pushes live over MQTT — the display reloads in seconds.</p>
      <Field label="Pages">
        <div className="flex gap-2">
          {["clock", "crypto", "slideshow"].map((p) => (
            <button key={p} className="btn" style={pages.includes(p) ? { borderColor: "var(--ccp-accent)", color: "var(--ccp-accent)" } : {}} onClick={() => togglePage(p)}>{p}</button>
          ))}
        </div>
      </Field>
      <Field label="Clock theme">
        <select className="select w-full" value={theme} onChange={(e) => setTheme(e.target.value)}>
          {["gold", "mint", "neon"].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </Field>
      <Field label="Crypto symbols (comma separated)">
        <input className="input w-full" value={symbols} onChange={(e) => setSymbols(e.target.value)} placeholder="BTCUSDT, ETHUSDT" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Currency">
          <select className="select w-full" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {["USD", "THB"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Fetch every">
          <select className="select w-full" value={fetchS} onChange={(e) => setFetchS(Number(e.target.value))}>
            {[5, 10, 30, 60, 300, 900].map((n) => <option key={n} value={n}>{n < 60 ? `${n}s` : `${n / 60}m`}</option>)}
          </select>
        </Field>
      </div>
      {pageSettings && (
        <div className="mt-5 border-t border-[var(--ccp-border)] pt-4">
          <div className="text-xs uppercase tracking-wide text-[var(--ccp-muted)] mb-3">{pageSettings.name} settings</div>
          <SchemaForm schema={pageSettings.schema} values={pageVals} onChange={(k, v) => setPageVals((p) => ({ ...p, [k]: v }))} />
        </div>
      )}
      <div className="flex gap-2 mt-5">
        <button className="btn btn-primary flex-1" disabled={busy} onClick={save}>{busy ? "Saving…" : "Push to display"}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-5 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-1">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="block text-xs text-[var(--ccp-muted)] mb-1.5">{label}</label>
      {children}
    </div>
  );
}
