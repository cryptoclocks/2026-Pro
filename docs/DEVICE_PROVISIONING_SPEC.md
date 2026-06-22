# Device Provisioning + User Binding — Spec (DECIDED: Option B, 2026-06-23)

Replaces the legacy Google Apps Script + Sheet "runId" with **API/Supabase**
provisioning. Admin provisions a new device by cable at sale time; the device
gets an immutable sequential id on first boot and joins CCP immediately (no
device-initiated call-in). Only one test device exists (admin's) → safe to
re-flash/re-provision.

## STATUS (2026-06-23) — stages 1–4 implemented + pushed
- ✅ **Stage 1 API** (`280327f`): Device.mac/claimCode + Counter (+migration);
  `nextDeviceId()`; `POST /devices/provision`; `POST /devices/:id/assign-owner`;
  hardened `claimByUser` (verify claimCode, block re-claim, accept CCP######).
  Typechecks clean. Email owner-binding already works (auth upserts by email).
- ✅ **Stage 2 admin web** (`546e5f6`): Fleet "+ Provision device" modal +
  Owner-assign box in Rights modal.
- ✅ **Stage 3 firmware** (`ec5e053`): NVS-provisioned serial; encId =
  AES("<id>-<MAC>"); `POST /api/v1/provision`. NOT compiled here (no ESP-IDF env)
  → build + re-flash the test device.
- ✅ **Stage 4 mqtt** (`3780b61`): firmware status carries id+mac; Node-RED bridge
  + API mqtt-bridge learn deviceId↔encId and multicast cmd to encId/AES(id)/plaintext.
- ⏳ **Stage 5**: retire the Apps Script (external — just stop calling it).

### To go live (operator steps)
1. **API**: on OCI `cd ~/ccp && git pull && cd server && docker compose -f docker-compose.prod.yml up -d --build` (runs the new migration).
2. **Web**: Vercel auto-deploys admin+user on push.
3. **Node-RED**: re-import `server/nodered/ccp-web-rpc-bridge.json` (replaces the CCP tab).
4. **Firmware**: build + flash the test device. It boots as `ccp-<mac>` until provisioned.
5. **Provision**: admin web → "+ Provision device" (enter MAC + buyer) → note deviceId/claimCode/token.
6. **Push id to device** (same-LAN http, not from Vercel https): `curl -X POST http://<device-ip>/api/v1/provision -H 'Content-Type: application/json' -d '{"deviceId":"CCP000001","token":"<token>"}'` → device reboots as CCP000001.
7. **Claim** (buyer): web-user → enter/scan deviceId + claimCode.

### NOT part of provisioning (still open)
- web-user **cloud photo upload** (needs a file transport; `supportsFiles=false` in cloud).
- profile **line-2 "(nickname) role"** composite (single-field binding can't concat).

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
  3. generate `claimCode` (e.g. nanoid 8) → store on Device (`claimCode` column)
  4. `device.create({deviceId, mac, claimCode, ownerId:null|byEmail,
     name:customerName, tokenHash, settings:{coin1,coin2,ads,permission,...}})`
     — ownerId stays null unless E2 email pre-bind applies
  5. grant default page entitlements (clock/crypto/slideshow/weather/profile/calendar)
  6. return `{deviceId, token, claimCode}` — admin pushes deviceId+token to the
     device's local /provision, and shows claimCode + QR (`CCP…|code`) to give the buyer
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

## E. USER ↔ deviceId BINDING  (REVISED 2026-06-23 per owner)
Rules:
- **1 user → many devices**; **1 device → exactly ONE owner** who alone can change
  settings (`Device.ownerId` single — schema already enforces this). A second
  user claiming an owned device must be **blocked** (transfer only via admin or
  an explicit release).
- Admin usually does NOT know the buyer's email (Shopee etc.), so **self-claim is
  PRIMARY**, email pre-bind is only a bonus for cashlessthailand.com logged-in
  buyers.

**E1. Self-claim (PRIMARY)** — after Gmail login, web-user offers:
  - **type** the CryptoClock id + claim code, OR
  - **scan QR** with the phone camera (web-user opens camera when on mobile;
    use `BarcodeDetector` with a jsQR fallback). QR encodes `CCP000007|<code>`.
  → `POST /devices/claim {deviceId, code}` → `claimByUser`. **Harden
  `claimByUser`**: verify `code === device.claimCode` AND reject if
  `device.ownerId` is already set to a different user (return 409). The
  `claimCode` is generated at provision (step B.4) and shown as text+QR
  (on the box / device screen / admin web).

**E2. Email pre-bind (optional)** — if admin knows the buyer Gmail (bought while
  logged in on cashlessthailand.com), provision can set `ownerId` by email.
  ⚠️ Requires the auth layer to reconcile a User by **email** on Gmail login
  (match shell row, attach Supabase `sub`) — VERIFY in `auth` and adjust.

**E3. Admin bind/transfer** — admin web can view every device and set/transfer
  `ownerId` (by user email or user id). New `POST /devices/:hwId/assign-owner`
  (AdminGuard) `{email|userId}` → upsert user + set ownerId (overrides E1 lock).

- web-user keys off the entered/scanned deviceId; after binding,
  `GET /devices/:id/entitlements` + ownership checks pass. Non-owners may view
  but not save settings (enforce via `assertCanManageDevice`).

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
