export default function FleetPage() {
  // M6: live fleet status via SSE from the API's MQTT bridge.
  return (
    <main className="p-8">
      <h1 className="text-xl font-semibold mb-2">Device Fleet</h1>
      <p className="text-sm text-[var(--ccp-muted)] mb-6">
        Claim a device, see online status, battery, FPS and the active package.
        Live data lands here in milestone M6 — start the API and infra with{" "}
        <code className="text-[var(--ccp-accent)]">docker compose up</code> +{" "}
        <code className="text-[var(--ccp-accent)]">pnpm dev</code>.
      </p>
      <div className="rounded-lg border border-[var(--ccp-border)] bg-[var(--ccp-panel)] p-6 text-sm text-[var(--ccp-muted)]">
        No devices claimed yet. Flash a CryptoClock Pro display and scan its claim QR.
      </div>
    </main>
  );
}
