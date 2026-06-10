"use client";

import { useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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
  lastSeenAt: string | null;
}

export default function FleetPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Device | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/v1/devices`, { cache: "no-store" });
      setDevices(await res.json());
      setErr(null);
    } catch {
      setErr(`Cannot reach the Hub API at ${API}. Run "pnpm dev" in /server.`);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const online = devices.filter((d) => d.online).length;

  return (
    <main className="p-6">
      <div className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-2xl font-semibold">Device Fleet</h1>
          <p className="text-sm text-[var(--ccp-muted)]">
            Live status, settings push, and remote commands for your displays.
          </p>
        </div>
        <div className="flex gap-3">
          <Stat label="Devices" value={`${devices.length}`} />
          <Stat label="Online" value={`${online}`} accent />
        </div>
      </div>

      {err && (
        <div className="card p-4 mb-4 text-sm text-[var(--ccp-red)]">{err}</div>
      )}

      {devices.length === 0 && !err ? (
        <div className="card p-8 text-sm text-[var(--ccp-muted)] text-center">
          No devices yet. Flash a CryptoClock Pro display and it appears here when
          it connects to MQTT.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {devices.map((d) => (
            <DeviceCard key={d.id} d={d} onEdit={() => setEditing(d)} onCmd={load} />
          ))}
        </div>
      )}

      {editing && (
        <SettingsModal
          device={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card px-4 py-2 text-center">
      <div
        className="text-xl font-bold"
        style={{ color: accent ? "var(--ccp-accent)" : "var(--ccp-fg)" }}
      >
        {value}
      </div>
      <div className="text-[11px] text-[var(--ccp-muted)] uppercase tracking-wide">
        {label}
      </div>
    </div>
  );
}

async function sendCmd(deviceId: string, type: string) {
  await fetch(`${API}/api/v1/devices/${deviceId}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type }),
  });
}

function DeviceCard({ d, onEdit, onCmd }: { d: Device; onEdit: () => void; onCmd: () => void }) {
  const pages = (d.settings?.pages as string[] | undefined) ?? [];
  const batt = d.battMv ? `${(d.battMv / 1000).toFixed(2)}V` : "—";
  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span
          className="dot"
          style={{ background: d.online ? "var(--ccp-green)" : "var(--ccp-muted)" }}
        />
        <div className="min-w-0">
          <div className="font-semibold truncate">{d.name ?? d.deviceId}</div>
          <div className="text-[11px] text-[var(--ccp-muted)] font-mono truncate">
            {d.deviceId}
          </div>
        </div>
        {d.locked && <span className="pill ml-auto">locked</span>}
      </div>

      <div className="grid grid-cols-2 gap-y-1 text-xs text-[var(--ccp-muted)]">
        <span>IP {d.ip ?? "—"}</span>
        <span>RSSI {d.rssi ?? "—"} dBm</span>
        <span>Batt {batt}</span>
        <span>FPS {d.fps?.toFixed(0) ?? "—"}</span>
        <span>fw {d.fwVersion ?? "—"}</span>
        <span>cfg v{d.settingsVersion}</span>
      </div>

      <div className="flex flex-wrap gap-1">
        {pages.length ? (
          pages.map((p) => (
            <span key={p} className="pill">
              {p}
            </span>
          ))
        ) : (
          <span className="text-xs text-[var(--ccp-muted)]">default pages</span>
        )}
      </div>

      <div className="flex gap-2 mt-1">
        <button className="btn btn-primary flex-1" onClick={onEdit}>
          Settings
        </button>
        <button className="btn" onClick={() => sendCmd(d.deviceId, "identify")}>
          Identify
        </button>
        <button
          className="btn"
          title="Reload UI"
          onClick={async () => {
            await sendCmd(d.deviceId, "reload");
            onCmd();
          }}
        >
          ↻
        </button>
      </div>
    </div>
  );
}

function SettingsModal({
  device,
  onClose,
  onSaved,
}: {
  device: Device;
  onClose: () => void;
  onSaved: () => void;
}) {
  const s = device.settings ?? {};
  const clock = (s.clock as Record<string, unknown>) ?? {};
  const crypto = (s.crypto as Record<string, unknown>) ?? {};
  const [pages, setPages] = useState<string[]>(
    (s.pages as string[]) ?? ["clock", "crypto", "slideshow"],
  );
  const [theme, setTheme] = useState<string>((clock.theme as string) ?? "gold");
  const [symbols, setSymbols] = useState<string>(
    ((crypto.symbols as string[]) ?? ["BTCUSDT"]).join(", "),
  );
  const [currency, setCurrency] = useState<string>((crypto.currency as string) ?? "USD");
  const [fetchS, setFetchS] = useState<number>((crypto.fetch_interval_s as number) ?? 10);
  const [busy, setBusy] = useState(false);

  const togglePage = (p: string) =>
    setPages((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  const save = async () => {
    setBusy(true);
    const config = {
      ...s,
      pages,
      clock: { ...clock, theme },
      crypto: {
        ...crypto,
        symbols: symbols.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean),
        currency,
        fetch_interval_s: fetchS,
      },
    };
    await fetch(`${API}/api/v1/devices/${device.deviceId}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });
    setBusy(false);
    onSaved();
  };

  return (
    <div
      className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-1">{device.name ?? device.deviceId}</h2>
        <p className="text-xs text-[var(--ccp-muted)] mb-4">
          Pushes live over MQTT — the display reloads in seconds.
        </p>

        <Field label="Pages">
          <div className="flex gap-2">
            {["clock", "crypto", "slideshow"].map((p) => (
              <button
                key={p}
                className="btn"
                style={
                  pages.includes(p)
                    ? { borderColor: "var(--ccp-accent)", color: "var(--ccp-accent)" }
                    : {}
                }
                onClick={() => togglePage(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Clock theme">
          <select className="select w-full" value={theme} onChange={(e) => setTheme(e.target.value)}>
            {["gold", "mint", "neon"].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Crypto symbols (comma separated)">
          <input
            className="input w-full"
            value={symbols}
            onChange={(e) => setSymbols(e.target.value)}
            placeholder="BTCUSDT, ETHUSDT"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Currency">
            <select className="select w-full" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {["USD", "THB"].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Fetch every">
            <select
              className="select w-full"
              value={fetchS}
              onChange={(e) => setFetchS(Number(e.target.value))}
            >
              {[5, 10, 30, 60, 300, 900].map((n) => (
                <option key={n} value={n}>
                  {n < 60 ? `${n}s` : `${n / 60}m`}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="flex gap-2 mt-5">
          <button className="btn btn-primary flex-1" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Push to display"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
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
