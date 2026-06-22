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
type SocialKey = "fb" | "yt" | "tt" | "ig";
type SocialStats = Record<SocialKey, { followers: string; following: string; secondaryLabel: string }>;
interface SocialResolveResponse {
  ok?: boolean;
  platform?: string;
  name?: string;
  followers?: string;
  following?: string;
  likes?: string;
  talkingAbout?: string;
  secondaryLabel?: string;
  secondaryValue?: string;
  warning?: string;
}

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
  const [provisioning, setProvisioning] = useState(false);

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
        <div className="flex gap-3 items-center">
          <button className="btn btn-primary" onClick={() => setProvisioning(true)}>+ Provision device</button>
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
      {provisioning && (
        <ProvisionModal token={token} onClose={() => setProvisioning(false)} onDone={load} />
      )}
    </main>
  );
}

/** Admin provisions a new device by cable at sale: assigns the next CCP serial,
    stores buyer details + MAC, and returns the deviceId + claim code + token. */
function ProvisionModal({ token, onClose, onDone }: { token: string | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<Record<string, string>>({
    mac: "", buyerEmail: "", firstname: "", lastname: "", position: "", company: "",
    customerName: "", ssid: "", pass: "", oldssid: "", coin1: "", coin2: "", ads: "", permission: "1",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ deviceId: string; token: string; claimCode: string } | null>(null);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  const submit = async () => {
    if (!f.mac.trim()) { setErr("MAC address is required"); return; }
    setBusy(true); setErr(null);
    try {
      const body = { ...f, permission: f.permission ? Number(f.permission) : undefined };
      const r = await api("/api/v1/devices/provision", token, { method: "POST", body: JSON.stringify(body) }) as { deviceId: string; token: string; claimCode: string };
      setResult(r);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Provision failed");
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Modal title="Device provisioned ✓" onClose={onClose}>
        <p className="text-xs text-[var(--ccp-muted)] mb-3">
          Boot the device on this MAC — it picks up this id. Give the claim code to the buyer to bind it to their account.
        </p>
        <Field label="Device ID"><input readOnly className="input w-full font-mono" value={result.deviceId} /></Field>
        <Field label="Claim code (buyer enters / scans QR)"><input readOnly className="input w-full font-mono" value={result.claimCode} /></Field>
        <Field label="Device token (provisioned to NVS)"><input readOnly className="input w-full font-mono text-xs" value={result.token} /></Field>
        <button className="btn btn-primary w-full mt-2" onClick={onClose}>Done</button>
      </Modal>
    );
  }

  const text = (k: string, label: string, ph = "") => (
    <Field label={label}><input className="input w-full" value={f[k]} onChange={(e) => set(k, e.target.value)} placeholder={ph} /></Field>
  );

  return (
    <Modal title="Provision new device" onClose={onClose}>
      <p className="text-xs text-[var(--ccp-muted)] mb-4">
        Assigns the next CCP serial and records the buyer. Connect the new device by cable; it joins as that id on boot.
      </p>
      <Field label="MAC address (required)">
        <input className="input w-full font-mono" value={f.mac} onChange={(e) => set("mac", e.target.value)} placeholder="98:3D:AE:E9:14:78" />
      </Field>
      <div className="grid grid-cols-2 gap-3">{text("firstname", "First name")}{text("lastname", "Last name")}</div>
      <div className="grid grid-cols-2 gap-3">{text("position", "Position / Role")}{text("company", "Company")}</div>
      {text("customerName", "Name of customer (device label)")}
      {text("buyerEmail", "Buyer Gmail (optional — auto-binds owner)", "buyer@gmail.com")}
      <div className="grid grid-cols-2 gap-3">{text("ssid", "WiFi SSID")}{text("pass", "WiFi password")}</div>
      {text("oldssid", "Old SSID (optional)")}
      <div className="grid grid-cols-2 gap-3">{text("coin1", "Coin 1", "BTCUSDT")}{text("coin2", "Coin 2", "ETHUSDT")}</div>
      <div className="grid grid-cols-2 gap-3">
        {text("ads", "Ads")}
        <Field label="Permission">
          <select className="select w-full" value={f.permission} onChange={(e) => set("permission", e.target.value)}>
            <option value="1">Active (1)</option>
            <option value="0">Locked (0)</option>
          </select>
        </Field>
      </div>
      {err && <div className="text-sm text-[var(--ccp-red)] mb-2">{err}</div>}
      <div className="flex gap-2 mt-3">
        <button className="btn btn-primary flex-1" disabled={busy} onClick={submit}>{busy ? "Provisioning…" : "Provision"}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
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
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerBusy, setOwnerBusy] = useState(false);

  const assignOwner = async () => {
    if (!ownerEmail.trim()) return;
    setOwnerBusy(true);
    try {
      await api(`/api/v1/devices/${device.deviceId}/assign-owner`, token, {
        method: "POST", body: JSON.stringify({ email: ownerEmail.trim() }),
      });
      onChanged();
      onClose();
    } finally {
      setOwnerBusy(false);
    }
  };

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

  // Hide un-owned drafts (half-finished / duplicate pages) — keep anything the
  // device already owns so it can still be revoked.
  const visible = catalog.filter((c) => owned.includes(c.slug) || c.published !== false);
  const pages = visible.filter((c) => c.kind === "PAGE");
  const features = visible.filter((c) => c.kind === "FEATURE");

  const row = (c: CatalogItem) => {
    const has = owned.includes(c.slug);
    return (
      <div key={c.slug} className="flex items-center gap-2 py-1.5 border-b border-[var(--ccp-border)]/40">
        <div className="flex-1">
          <div className="text-sm">{c.title}</div>
          <div className="text-[11px] text-[var(--ccp-muted)]">
            {c.slug} · {formatMoney(c.priceCents, c.currency)}{c.published === false ? " · draft" : ""}
          </div>
        </div>
        <button className={has ? "btn btn-danger" : "btn btn-primary"} disabled={busy} onClick={() => toggle(c.slug, has)}>
          {has ? "Revoke" : "Grant"}
        </button>
      </div>
    );
  };

  return (
    <Modal onClose={onClose} title={`Rights — ${device.name ?? device.deviceId}`}>
      <p className="text-xs text-[var(--ccp-muted)] mb-3">
        Rights attach to this specific CryptoClock. Granting pushes it to the device instantly.
      </p>
      <div className="mb-3 pb-3 border-b border-[var(--ccp-border)]/40">
        <div className="text-[10px] uppercase tracking-wide text-[var(--ccp-muted)] mb-1">Owner</div>
        <div className="text-xs text-[var(--ccp-muted)] mb-1.5">Current: {device.owner?.email ?? "unclaimed"}</div>
        <div className="flex gap-2">
          <input className="input flex-1" placeholder="buyer@gmail.com" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
          <button className="btn" disabled={ownerBusy || !ownerEmail.trim()} onClick={assignOwner}>{ownerBusy ? "…" : "Assign"}</button>
        </div>
      </div>
      {pages.length > 0 && (
        <>
          <div className="text-[10px] uppercase tracking-wide text-[var(--ccp-muted)] mt-1 mb-1">Pages</div>
          {pages.map(row)}
        </>
      )}
      {features.length > 0 && (
        <>
          <div className="text-[10px] uppercase tracking-wide text-[var(--ccp-muted)] mt-4 mb-1">Features</div>
          {features.map(row)}
        </>
      )}
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
  const profile = (s.profile as Record<string, unknown>) ?? {};
  const clock = (s.clock as Record<string, unknown>) ?? {};
  const crypto = (s.crypto as Record<string, unknown>) ?? {};
  const slideshow = (s.slideshow as Record<string, unknown>) ?? {};
  const [pages, setPages] = useState<string[]>((s.pages as string[]) ?? ["clock", "crypto", "slideshow"]);
  const [theme, setTheme] = useState<string>((clock.theme as string) ?? "gold");
  const [ownerName, setOwnerName] = useState<string>((profile.name as string) ?? device.name ?? device.deviceId);
  const [nickname, setNickname] = useState<string>((profile.nickname as string) ?? "SATOSHI NAKAMOTO");
  const [role, setRole] = useState<string>((profile.role as string) ?? "(SAT) CYPHERPUNK");
  const [motto, setMotto] = useState<string>((profile.motto as string) ?? "DON'T TRUST  VERIFY");
  const [company, setCompany] = useState<string>((profile.company as string) ?? "Acme Capital");
  const [showProfile, setShowProfile] = useState<boolean>((profile.show as boolean) ?? true);
  const [nameColor, setNameColor] = useState<string>((profile.name_color as string) ?? "#EAECEF");
  const [roleColor, setRoleColor] = useState<string>((profile.role_color as string) ?? "#848E9C");
  const [companyColor, setCompanyColor] = useState<string>((profile.company_color as string) ?? "#F0B90B");
  const [verifyColor, setVerifyColor] = useState<string>((profile.verify_color as string) ?? "#F0B90B");
  const [bgColor, setBgColor] = useState<string>((profile.bg_color as string) ?? "#0B0E11");
  const [fbUrl, setFbUrl] = useState<string>((profile.fb_url as string) ?? "");
  const [ytUrl, setYtUrl] = useState<string>((profile.yt_url as string) ?? "");
  const [ttUrl, setTtUrl] = useState<string>((profile.tt_url as string) ?? "");
  const [igUrl, setIgUrl] = useState<string>((profile.ig_url as string) ?? "");
  const [socialStats, setSocialStats] = useState<SocialStats>({
    fb: {
      followers: (profile.fb_followers as string) ?? "",
      following: (profile.fb_following as string) ?? "",
      secondaryLabel: (profile.fb_secondary_label as string) ?? "Following",
    },
    yt: {
      followers: (profile.yt_followers as string) ?? "",
      following: (profile.yt_following as string) ?? "",
      secondaryLabel: (profile.yt_secondary_label as string) ?? "Following",
    },
    tt: {
      followers: (profile.tt_followers as string) ?? "",
      following: (profile.tt_following as string) ?? "",
      secondaryLabel: (profile.tt_secondary_label as string) ?? "Following",
    },
    ig: {
      followers: (profile.ig_followers as string) ?? "",
      following: (profile.ig_following as string) ?? "",
      secondaryLabel: (profile.ig_secondary_label as string) ?? "Following",
    },
  });
  const [symbols, setSymbols] = useState<string>(((crypto.symbols as string[]) ?? ["BTCUSDT"]).join(", "));
  const [style, setStyle] = useState<string>((crypto.style as string) ?? "chart");
  const [currency, setCurrency] = useState<string>((crypto.currency as string) ?? "USD");
  const [fetchS, setFetchS] = useState<number>((crypto.fetch_interval_s as number) ?? 10);
  const [slideEffect, setSlideEffect] = useState<string>((slideshow.effect as string) ?? "fade");
  const [slideInterval, setSlideInterval] = useState<number>((slideshow.interval_s as number) ?? 5);
  const [socialBusy, setSocialBusy] = useState(false);
  const [socialNote, setSocialNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const togglePage = (p: string) => setPages((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  // admin-declared per-page settings form (from the active package's settings_schema)
  const pageSettings = activePageSettings(device);
  const [pageVals, setPageVals] = useState<SettingsValues>(
    pageSettings ? withDefaults(pageSettings.schema, (s[pageSettings.slug] as SettingsValues) ?? {}) : {},
  );

  const save = async () => {
    setBusy(true);
    try {
      const config: Record<string, unknown> = {
        ...s,
        pages,
        profile: {
          ...profile,
          name: ownerName.trim(),
          nickname: nickname.trim(),
          role: role.trim(),
          motto: motto.trim(),
          company: company.trim(),
          show: showProfile,
          name_color: nameColor.trim(),
          role_color: roleColor.trim(),
          company_color: companyColor.trim(),
          verify_color: verifyColor.trim(),
          bg_color: bgColor.trim(),
          fb_url: fbUrl.trim(),
          yt_url: ytUrl.trim(),
          tt_url: ttUrl.trim(),
          ig_url: igUrl.trim(),
          fb_followers: socialStats.fb.followers.trim(),
          fb_following: socialStats.fb.following.trim(),
          fb_secondary_label: socialStats.fb.secondaryLabel.trim(),
          yt_followers: socialStats.yt.followers.trim(),
          yt_following: socialStats.yt.following.trim(),
          yt_secondary_label: socialStats.yt.secondaryLabel.trim(),
          tt_followers: socialStats.tt.followers.trim(),
          tt_following: socialStats.tt.following.trim(),
          tt_secondary_label: socialStats.tt.secondaryLabel.trim(),
          ig_followers: socialStats.ig.followers.trim(),
          ig_following: socialStats.ig.following.trim(),
          ig_secondary_label: socialStats.ig.secondaryLabel.trim(),
        },
        clock: { ...clock, theme },
        crypto: {
          ...crypto,
          style,
          symbols: symbols.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean),
          currency,
          fetch_interval_s: fetchS,
        },
        slideshow: {
          ...slideshow,
          effect: slideEffect,
          interval_s: slideInterval,
        },
      };
      if (pageSettings) config[pageSettings.slug] = pageVals; // settings.<slug> for the page
      await api(`/api/v1/devices/${device.deviceId}/settings`, token, { method: "PUT", body: JSON.stringify({ config }) });
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const refreshSocialStats = async () => {
    const urls: Record<SocialKey, string> = { fb: fbUrl, yt: ytUrl, tt: ttUrl, ig: igUrl };
    const platforms: Record<SocialKey, string> = { fb: "facebook", yt: "youtube", tt: "tiktok", ig: "instagram" };
    const next: SocialStats = {
      fb: { ...socialStats.fb },
      yt: { ...socialStats.yt },
      tt: { ...socialStats.tt },
      ig: { ...socialStats.ig },
    };
    setSocialBusy(true);
    setSocialNote(null);
    try {
      const notes: string[] = [];
      for (const key of Object.keys(urls) as SocialKey[]) {
        const url = urls[key].trim();
        if (!url) continue;
        const r = await api("/api/v1/social/resolve", token, {
          method: "POST",
          body: JSON.stringify({ url, platform: platforms[key] }),
        }) as SocialResolveResponse;
        const followers = r.followers || r.likes || "";
        const following = r.secondaryValue || r.following || r.talkingAbout || "";
        next[key] = {
          followers: followers || next[key].followers,
          following: following || next[key].following,
          secondaryLabel: r.secondaryLabel || next[key].secondaryLabel || "Following",
        };
        notes.push(`${key.toUpperCase()}: ${followers || "?"} / ${following || "?"}${r.warning ? " (best effort)" : ""}`);
      }
      setSocialStats(next);
      setSocialNote(notes.length ? notes.join(" · ") : "Add at least one social URL first.");
    } catch (e) {
      setSocialNote(e instanceof Error ? e.message : "Cannot refresh social stats.");
    } finally {
      setSocialBusy(false);
    }
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
      <Field label="Profile name">
        <input className="input w-full" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Satoshi Nakamoto" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Nickname">
          <input className="input w-full" value={nickname} onChange={(e) => setNickname(e.target.value)} />
        </Field>
        <Field label="Role">
          <input className="input w-full" value={role} onChange={(e) => setRole(e.target.value)} />
        </Field>
      </div>
      <Field label="Motto (top-right)">
        <input className="input w-full" value={motto} onChange={(e) => setMotto(e.target.value)} placeholder="DON'T TRUST  VERIFY" />
      </Field>
      <Field label="Company">
        <input className="input w-full" value={company} onChange={(e) => setCompany(e.target.value)} />
      </Field>
      <Field label="Show profile page">
        <button type="button" className="btn" style={showProfile ? { borderColor: "var(--ccp-accent)", color: "var(--ccp-accent)" } : {}} onClick={() => setShowProfile((v) => !v)}>
          {showProfile ? "Enabled" : "Hidden"}
        </button>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name colour">
          <input className="input w-full font-mono" value={nameColor} onChange={(e) => setNameColor(e.target.value)} />
        </Field>
        <Field label="Role colour">
          <input className="input w-full font-mono" value={roleColor} onChange={(e) => setRoleColor(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Company colour">
          <input className="input w-full font-mono" value={companyColor} onChange={(e) => setCompanyColor(e.target.value)} />
        </Field>
        <Field label="Motto colour">
          <input className="input w-full font-mono" value={verifyColor} onChange={(e) => setVerifyColor(e.target.value)} />
        </Field>
      </div>
      <Field label="Background colour">
        <input className="input w-full font-mono" value={bgColor} onChange={(e) => setBgColor(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Facebook URL">
          <input className="input w-full" value={fbUrl} onChange={(e) => setFbUrl(e.target.value)} />
        </Field>
        <Field label="YouTube URL">
          <input className="input w-full" value={ytUrl} onChange={(e) => setYtUrl(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="TikTok URL">
          <input className="input w-full" value={ttUrl} onChange={(e) => setTtUrl(e.target.value)} />
        </Field>
        <Field label="Instagram URL">
          <input className="input w-full" value={igUrl} onChange={(e) => setIgUrl(e.target.value)} />
        </Field>
      </div>
      <Field label="Public social stats">
        <button type="button" className="btn w-full" disabled={socialBusy} onClick={refreshSocialStats}>
          {socialBusy ? "Reading public pages..." : "Refresh from social URLs"}
        </button>
        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-[var(--ccp-muted)]">
          {(Object.keys(socialStats) as SocialKey[]).map((k) => (
            <div key={k} className="rounded-lg border border-[var(--ccp-border)] px-2 py-1">
              <span className="font-semibold uppercase text-[var(--ccp-fg)]">{k}</span>{" "}
              {socialStats[k].followers || "—"} / {socialStats[k].following || "—"} {socialStats[k].secondaryLabel}
            </div>
          ))}
        </div>
        {socialNote && <p className="mt-2 text-xs text-[var(--ccp-muted)]">{socialNote}</p>}
      </Field>
      <Field label="Crypto symbols (comma separated)">
        <input className="input w-full" value={symbols} onChange={(e) => setSymbols(e.target.value)} placeholder="BTCUSDT, ETHUSDT" />
      </Field>
      <Field label="Crypto style">
        <select className="select w-full" value={style} onChange={(e) => setStyle(e.target.value)}>
          {["chart", "big"].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
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
      <div className="mt-5 border-t border-[var(--ccp-border)] pt-4">
        <div className="text-xs uppercase tracking-wide text-[var(--ccp-muted)] mb-3">Photos settings</div>
        <Field label="Effect">
          <select className="select w-full" value={slideEffect} onChange={(e) => setSlideEffect(e.target.value)}>
            {["fade", "slide", "none"].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </Field>
        <Field label="Interval">
          <select className="select w-full" value={slideInterval} onChange={(e) => setSlideInterval(Number(e.target.value))}>
            {[3, 5, 10, 15, 30].map((n) => <option key={n} value={n}>{`${n}s`}</option>)}
          </select>
        </Field>
        <p className="text-xs text-[var(--ccp-muted)]">The mobile app can still manage the photo files themselves; this lets Fleet keep the same page behavior/config.</p>
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
      <div className="card w-full max-w-2xl p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
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
