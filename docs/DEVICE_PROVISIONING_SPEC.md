# Device Provisioning + User Binding — Spec (DECIDED: Option B, 2026-06-23)

Replaces the legacy Google Apps Script + Sheet "runId" with **API/Supabase**
provisioning. Admin provisions a new device by cable at sale time; the device
gets an immutable sequential id on first boot and joins CCP immediately (no
device-initiated call-in). Only one test device exists (admin's) → safe to
re-flash/re-provision.

## Decision (Option B = full legacy identity)
- **device_id = `CCP000001`…`CCP999999`** (sequential, assigned by API in a DB
  transaction). NOT `ccp-<mac>` anymore.
- **clientId / topic id (encId) = AES-128-CBC(`<deviceId>-<MAC>`)**, key=iv
  `ClocktoCrypt1234`, PKCS#7, lowercase hex. **MAC is UPPERCASE colon form**
  e.g. plaintext `CCP000003-5C:01:3B:66:D8:70` (matches legacy ESP32 + the
  Node-RED `track_client` decoder in the OTA flow → new devices show up in
  `clients_ccp` and work with existing OTA automatically).
- Source of truth = **Supabase** (retire the Apps Script; optionally mirror to
  Sheet read-only later).

## A. Firmware changes
- `device_security.c`: `device_security_id()` returns NVS `prov/device_id` if
  set (e.g. `CCP000007`); else fall back to `ccp-<mac>` (unprovisioned). Add
  `device_security_set_provision(deviceId, token)` → writes NVS + reboots.
- `app_main.c` (~line 538): build encId from **`<deviceId>-<MAC-UPPER-COLON>`**,
  not just deviceId. Add a MAC formatter `%02X:%02X:...` (uppercase). Keep the
  plaintext fallback on AES failure.
- `local_api.c`: add `POST /api/v1/provision` body
  `{deviceId, token, ssid?, pass?}` → store WiFi creds + call
  `device_security_set_provision`. (Admin pushes this over the cable/LAN.)
- MQTT username stays the plaintext deviceId (`CCP000007`); topics use encId.

## B. API changes (`server/apps/api`)
- **Sequential counter**: add a `Counter` model (or a single-row table) and a
  `nextDeviceId()` that runs inside `prisma.$transaction` (increment + format
  `CCP%06d`) to avoid races.
- **`POST /devices/provision`** (AdminGuard) body:
  `{mac, buyerEmail, firstname,lastname,position,company, ssid,pass,oldssid,
    permission,active, coin1,coin2, customerName, ads}` →
  1. `deviceId = nextDeviceId()`
  2. upsert owner `User` by `buyerEmail` (shell row if not signed-in yet)
  3. `device.create({deviceId, mac, ownerId, name:customerName, tokenHash,
     settings:{coin1,coin2,ads,permission,...buyer fields}})`
  4. grant default page entitlements (clock/crypto/slideshow/weather/profile/calendar)
  5. return `{deviceId, token}` (admin pushes to the device's local /provision)
- **Relax device-id validation**: claim/route regex currently
  `/^ccp-[0-9a-f]{12}$/` → also accept `/^CCP\d{6}$/`. Grep for that regex +
  `deviceId` param validators and update.
- **`mqtt-bridge.service.ts` encId**: address/ingest devices by
  `AES(deviceId + "-" + device.mac)`. Needs `device.mac` (now stored at
  provision) → add an `aesEncrypt` helper to `@ccp/shared` and look up MAC.
  (This also fixes the §7.2 admin-online/command gap from CLOUD_DEPLOY_HANDOFF.)

## C. Node-RED bridge (`server/nodered/ccp-web-rpc-bridge.json`)
- encId now = `AES(deviceId + "-" + MAC)`. The bridge gets only `deviceId` from
  the web → resolve MAC via the existing `clients_ccp` flow map (the OTA flow's
  `track_client` already decodes `clientReady` → `{deviceId, mac, clientId}`).
  So: look up the `clients_ccp` entry whose `deviceId` matches and reuse its
  `clientId` as encId (no AES needed in the bridge), OR compute
  `AES(deviceId-mac)`. Keep dual-publish (encId + plaintext) during migration.

## D. Admin web (`server/apps/web`)
- New page "Provision new device" (cable/first-boot):
  1. read device MAC (GET `http://<device-ip>/api/v1/info`) or manual entry
  2. form: buyer fields above
  3. `POST {API}/devices/provision` → `{deviceId, token}`
  4. `POST http://<device-ip>/api/v1/provision {deviceId, token, ssid, pass}`
  5. device reboots → online as `CCP000007`, already in DB → works immediately

## E. USER ↔ deviceId BINDING (the key question)
Two paths, both end at `device.ownerId = <the Gmail user>`:
1. **Pre-bind at provision (primary)** — admin enters the buyer's **Gmail** in
   the provision form → API upserts a `User` by that email and sets
   `device.ownerId`. When the buyer logs in with that Gmail, the auth layer must
   **reconcile by email** (match the existing shell User, attach the Supabase
   `sub`) so they instantly own the device. ⚠️ VERIFY `auth` upserts/matches
   User by email, not only by Supabase `sub` — adjust if needed.
2. **Self-claim (fallback)** — buyer logs in, web-user shows "Enter CryptoClock
   ID + claim code" → `POST /devices/claim {deviceId, code}` (existing
   `claimByUser`) → binds. Use for devices sold without pre-bind.
- web-user already keys everything off the entered deviceId; after binding,
  `GET /devices/:id/entitlements` + ownership checks pass.

## F. Migration of the existing test device
`ccp-983daee91478` → provision to get `CCP000001`, re-flash firmware (B), device
reconnects as `CCP000001` with `AES(CCP000001-<mac>)`. Delete/ignore the old
`ccp-983daee91478` row + its entitlements (re-grant on the new id).

## Implementation order (suggested)
1. API: Counter + `nextDeviceId()` + `POST /devices/provision` + relax regex +
   email-based owner binding. (Standalone; doesn't break the working web path.)
2. Admin web: provision page.
3. Firmware: NVS provisioned id + `AES(id-mac)` + local `/provision` endpoint; re-flash test device.
4. Bridge + `mqtt-bridge.service.ts`: switch encId to `AES(id-mac)` (drop the
   `ccp-<mac>` form once no device uses it).
5. Retire Apps Script.

Files: see CLOUD_DEPLOY_HANDOFF.md §8. Legacy reference (clientId=AES(id-mac),
MAC uppercase-colon, `track_client` decoder, OTA per-type flows) is in the
Node-RED export the user pasted on 2026-06-23.
