# Cloud Deploy Handoff — Hub API on OCI + Web↔Device MQTT (2026-06-22)

Handoff for the next AI/engineer. The goal of this work stream: make the **web
apps control real devices over the internet** (no LAN). The user-web command
path is now live and verified; the remaining gaps are listed in §7.

## 1. What is live (verified)
- **Hub API** runs on the OCI VM in Docker → `https://api.cashlessthailand.com`
  (returns 200, catalog = 8 items). DB = Supabase Postgres (pooler).
- **Web apps** (Vercel):
  - admin `https://2026-pro-admin.vercel.app` (Next.js, repo `server/apps/web`)
  - user  `https://2026-pro-user.vercel.app`  (Vite single-file, repo `web-user/index.html`)
  - Both have env set; Google login works.
- **MQTT WSS** for browsers → `wss://mqtt-ccp.cashlessthailand.com/mqtt`
  (Caddy → Aedes ws `127.0.0.1:8083`). Browser WSS connect returns 101 ✅.
- **Node-RED RPC bridge** imported & deployed → web RPC reaches devices.
  `web-user Connect` to `ccp-983daee91478` succeeds.
- **Device commands/settings verified live (2026-06-22)** → Node-RED publishes
  to both encrypted and legacy plaintext topics. `ping` returned ACK and
  `Save to display` returned `Saved — display reloading`.
- **Admin/API MQTT status verified live (2026-06-23)** → API and Node-RED share
  Docker network `nodered-aedes_default`; API connects to
  `mqtt://jarvis-nodered:1883`. Do not restore `host.docker.internal`: on this
  Linux VM it accepts TCP but never returns MQTT CONNACK from the API network.
- **Device registered**: claimed into the new DB + 16 entitlements granted
  (clock/crypto/slideshow/weather/profile/calendar + clock-alarm/crypto-alerts).
  Done via a browser-console snippet hitting `POST /devices/claim` then
  `POST /devices/:id/grant` (see §6).

## 2. Infra topology (do NOT break the co-located system)
```
Vercel(admin,user) ─https─► OCI 161.118.241.148 (Ubuntu 22.04, ARM, Singapore)
                            ├─ ProjectSupporter Caddy :80/:443  (SHARED — another
                            │    Vercel app's repo; manages /tmp/projectsupporter/Caddyfile)
                            │     ├─ api.cashlessthailand.com      → :4000  (our API, appended)
                            │     ├─ mqtt-ccp.cashlessthailand.com → :8083  (Aedes ws, appended)
                            │     └─ /mqtt*, /api/*, /iot-portal/* (ProjectSupporter — untouched)
                            ├─ jarvis-nodered + jarvis-aedes  (MQTT broker 1883/1886, ws 8083/9001)
                            └─ our API container :4000 (docker compose, bound 127.0.0.1)
Supabase Postgres (pooler) ◄─ DATABASE_URL/DIRECT_URL
ESP32 devices ─mqtt:1883─► Aedes  (node-red.cashlessthailand.com → same IP)
```
HARD RULES: never `systemctl restart` the Caddy (use `sudo systemctl reload
projectsupporter-caddy`); never touch broker ports/Node-RED core flows/ESP32
legacy (`/cryptoclock/ccn/...`, AES key `ClocktoCrypt1234`). Caddy blocks were
**appended** to `/tmp/projectsupporter/Caddyfile` (ephemeral — see §7 follow-up).

## 3. The MQTT addressing scheme (critical)
- Device id (plaintext): `ccp-<mac-lowercase>` e.g. `ccp-983daee91478`
  (`device_security.c`: `snprintf("ccp-%02x...", mac)`).
- **encId = AES-128-CBC(device_id, key=iv="ClocktoCrypt1234", PKCS#7, lowercase hex)**
  (`firmware/components/device_security/cc_aes.c`, default `CC_AES_PAD_PKCS7`).
  For `ccp-983daee91478` → `d969dc6a341c5935ae0545f428ed45e5404adfc10a9426dc8a99a723db40ed7e`.
- Device topics use **encId**: subscribes `ccp/v1/<encId>/cmd`, publishes
  `ccp/v1/<encId>/status|cmd/res|telemetry` (`connectivity.c`). Username = plaintext id.
- Device cmd protocol: in `{id,type,params}` → out `{id,ok,error}` on `cmd/res`.
  Types handled (`app_main.c on_cmd`): ping/reboot/brightness/identify/show_page/
  sync/reload/settings/ota/lock/unlock/wipe. (NO wifi_reset, NO settings readback.)
- Node-RED bridge derives the SAME encId (Node `crypto`, PKCS7) — see
  `server/nodered/ccp-web-rpc-bridge.json`. Web RPC ↔ device:
  `ccp/web/user/<uid>/request|response/<id>`  ↔  `ccp/v1/<encId>/cmd|cmd/res`.

## 4. Web-user cloud RPC contract (`web-user/index.html`)
`CloudDeviceApi` calls via MQTT: `device.info`, `device.settings.get`,
`device.settings.put` (`{config}`), `device.command` (`{type,params}`).
Bridge: `device.info` answered from cached retained status; `settings.put`/
`command` forwarded to device and correlated by id on `cmd/res`;
`settings.get` returns `{config:{}}` (gap — device can't read back over MQTT).

## 5. DEVICE COMMAND TIMEOUT — diagnosed and fixed in the bridge flow
Original symptom: web-user Connect worked, but `device.settings.put` (and any
`device.command`) timed out.

Live diagnosis on 2026-06-22: publishing distinct `ping` commands to both topic
forms produced a response only on the plaintext form:
`ccp/v1/ccp-983daee91478/cmd/res`. The device is online and currently
subscribes `ccp/v1/ccp-983daee91478/cmd`; it does not subscribe the encId topic.

`server/nodered/ccp-web-rpc-bridge.json` now publishes commands to both the
encrypted and plaintext topics. It also checks both keys in the status cache.
This flow was deployed live through the local Node-RED Admin API on
2026-06-22. No broker/container restart was performed.

Verification after deploy:
- bridge RPC `device.command`/`ping` returned `{ok:true}`;
- web-user `Save to display` returned `Saved — display reloading`;
- `jarvis-nodered` remained healthy and `jarvis-aedes` was not restarted.

VM rollback backups:
- `/home/ubuntu/flows.json.ccp-backup-20260622T113855Z`
- `/home/ubuntu/ccp-tab-backup-20260622T113855Z.json`

device_id format + AES verified to MATCH on both sides → the cmd SHOULD reach
the encrypted-topic firmware. Before the live diagnosis, timeout had three
possible causes:
1. **Device offline** — Connect still "succeeds" because `device.info` returns
   the cached/LWT retained status (possibly `{online:false}`), so no timeout there.
2. **Device fell back to PLAINTEXT topics** — `app_main.c` ~line 538: if
   `cc_aes_encrypt_hex()` fails at boot, `client_id=""` → device subscribes
   `ccp/v1/ccp-983daee91478/cmd` (plaintext), but the bridge publishes to
   `ccp/v1/d969…ed7e/cmd` → mismatch → timeout. Look for boot log
   `clientId encrypt failed`.
3. Device online + encId correct but not ACKing (device-side or bridge corr.).

### How to diagnose (pick one)
- **Serial log** (fastest): `connectivity.c:45` prints
  `MQTT connected, subscribed ccp/v1/<X>/cmd`. Compare `<X>`:
  `d969…ed7e` = encId OK (then it's offline/ack); `ccp-983daee91478` = plaintext fallback.
- **On the VM**: `sudo apt install -y mosquitto-clients` (client only, safe) then
  `mosquitto_sub -h localhost -t 'ccp/v1/#' -v`. Check the device's status topic
  (which encId? online true/false), and whether a `…/cmd` shows up on Save and a
  `…/cmd/res` comes back.

### Fixes per case
- Offline → power/WiFi the device.
- Plaintext/older firmware → the bridge compatibility fix now publishes cmd to
  BOTH `ccp/v1/<encId>/cmd` and `ccp/v1/<plaintextId>/cmd`. A later firmware
  flash can move the device to encId topics without breaking the web.
- No ack → add a debug node on `ccp/v1/+/cmd/res` in Node-RED; confirm `id`
  correlation in `ccp_fn_res`.

## 6. Re-running device claim + grant (browser console on the user web)
```js
const t=localStorage.getItem('ccp_access_token');
const base='https://api.cashlessthailand.com/api/v1', dev='ccp-983daee91478';
await fetch(`${base}/devices/claim`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({deviceId:dev,code:'manual',name:'My CryptoClock'})}).then(r=>r.json()).then(console.log);
for(const s of ['clock','crypto','slideshow','weather','profile','calendar','clock-alarm','crypto-alerts'])
  await fetch(`${base}/devices/${dev}/grant`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({slug:s})}).then(r=>r.json()).then(x=>console.log(s,x));
```

## 7. Remaining work (TODO)
1. **User-web device commands — DONE** — dual-topic bridge deployed and
   Save/ping verified against `ccp-983daee91478` on 2026-06-22.
2. **Admin online status + command addressing — DONE in source; production
   transport fixed 2026-06-23.** The API maintains plaintext/encId mappings and
   publishes compatible command topics. Fleet remained offline because
   `MQTT_URL=mqtt://host.docker.internal:1883` hit a Docker host-gateway
   hairpin that timed out waiting for CONNACK. Production compose now joins
   `nodered-aedes_default`, and `.env.prod` must use
   `MQTT_URL=mqtt://jarvis-nodered:1883`.
3. **`device.settings.get` gap** — bridge returns `{config:{}}` so web settings
   pages show defaults, not the device's live config. FIX: add a firmware
   `get_settings` cmd that replies config on `cmd/res`, OR have the bridge/web
   read config from the API DB (`GET /devices/:id/settings`).
4. **Persist Caddy blocks** — the api./mqtt-ccp. blocks are in `/tmp` (lost on
   reboot). Add them to ProjectSupporter's source repo. Backup on VM:
   `/tmp/projectsupporter/Caddyfile.bak.*`.
5. **Rotate secrets** if the chat transcript is a concern (Supabase DB password
   + `JWT_SECRET` in `~/ccp/server/.env.prod`), then `docker compose restart api`.
6. **Factory serial + customer registration** — follow
   `docs/DEVICE_REGISTRATION_PLAN.md`. Important: the current claim endpoint
   accepts a code without validating it and can replace an owner; secure the
   claim flow before exposing customer self-registration.

## 8. Key files
| Path | Role |
|---|---|
| `server/apps/api/Dockerfile`, `server/docker-compose.prod.yml` | API container (Rust+Node, payloads volume) |
| `server/.env.prod` (VM only, gitignored) | API secrets; `.env.prod.example` is the template |
| `server/apps/api/prisma/schema.prisma` | `directUrl` added for Supabase pooler migrations |
| `server/package.json` | `packageManager: pnpm@10.28.0` (corepack pin) |
| `server/nodered/ccp-web-rpc-bridge.json` | **the Node-RED RPC bridge flow** (import into Node-RED) |
| `server/apps/api/src/mqtt/mqtt-bridge.service.ts` | API↔device MQTT (TODO §7.2: plaintext vs encId) |
| `server/apps/api/src/devices/devices.{service,controller}.ts` | claim/grant/entitlements/settings |
| `web-user/index.html` | user web; `CloudDeviceApi` + `MqttRpc` + `Hub` |
| `firmware/components/device_security/cc_aes.c` | encId = AES-128-CBC PKCS7 hex |
| `firmware/components/connectivity/connectivity.c` | device MQTT (topics, subscribe, cmd dispatch) |
| `firmware/main/app_main.c` | `on_cmd` handler, `publish_status`, encId build (~line 538) |

## 9. Update / redeploy
- API: `cd ~/ccp && git pull && cd server && docker compose -f docker-compose.prod.yml up -d --build`
- Web: push to `origin/main` → Vercel auto-deploys both projects.
- Node-RED flow: re-import `server/nodered/ccp-web-rpc-bridge.json` if changed.

See also `~/.claude/.../memory/hub-api-oci-deploy.md` for the deploy rules.
