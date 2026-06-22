# Admin/User Web Deployment with CryptoClock WSS

This repository deploys two independent Vercel projects.

## Domains

| Project | Vercel root | Domain |
|---|---|---|
| Admin | `server` | `admin.cashlessthailand.com` |
| User web | `web-user` | `ccp-user.cashlessthailand.com` |

Both browser apps connect to:

```text
wss://mqtt-ccp.cashlessthailand.com/mqtt
```

The public WSS hostname may be Cloudflare proxied because it uses HTTPS
WebSocket on port 443. Keep `node-red.cashlessthailand.com` DNS-only so existing
ESP32 clients continue using raw MQTT TCP port 1883.

Do not touch the separate IoT broker on ports 1886/9091.

## Admin Vercel project

Set Root Directory to `server`. `server/vercel.json` builds `@ccp/web`.

Environment variables:

```env
NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-browser-publishable-key
NEXT_PUBLIC_MQTT_WS_URL=wss://mqtt-ccp.cashlessthailand.com/mqtt
```

The Admin UI connects only after the Hub verifies that the Supabase user has an
admin role. The production allowlist must contain `mycryptoclock@gmail.com`.

The existing Hub/API environment must allow both web origins:

```env
WEB_ORIGIN=https://admin.cashlessthailand.com,https://ccp-user.cashlessthailand.com
PUBLIC_WEB_URL=https://admin.cashlessthailand.com
CCP_STAGED_ROLLOUT_OWNER_EMAIL=mycryptoclock@gmail.com
```

## User Vercel project

Set Root Directory to `web-user`; see `web-user/README.md`.

## Supabase redirects

Add:

```text
https://admin.cashlessthailand.com/login
https://ccp-user.cashlessthailand.com/
http://localhost:3000/login
http://localhost:8099/
```

## Security boundary

Browser applications may contain only publishable values:

- Supabase publishable/anon key
- public HTTPS API URL
- public WSS URL

Never expose:

- Supabase `service_role`
- database URLs or passwords
- Stripe secret/webhook keys
- Node-RED Editor credentials
- Aedes master credentials
- per-device permanent tokens

The browser uses its short-lived Supabase access token as the MQTT password.
The WSS gateway must verify JWT signature, issuer, audience, expiry, role, and
device ownership. Browsers must never be allowed to publish directly to
`ccp/v1/+/cmd`.

## Node-RED gateway contract

Admin:

```text
publish   ccp/web/admin/<user-id>/request/#
subscribe ccp/web/admin/<user-id>/response/#
subscribe ccp/web/admin/<user-id>/fleet/#
```

User:

```text
publish   ccp/web/user/<user-id>/request/#
subscribe ccp/web/user/<user-id>/response/#
subscribe ccp/web/user/<user-id>/devices/#
```

The gateway validates requests, then Node-RED forwards approved commands to:

```text
ccp/v1/<device-id>/cmd
```

Existing local OTA pages remain local and continue using the current
1883/8083 broker path. Large package, firmware, and image transfers remain
HTTPS downloads/uploads rather than MQTT payloads.

## Not complete until OCI is configured

The browser code is ready for WSS, but production control will not work until
OCI provides:

1. `wss://mqtt-ccp.cashlessthailand.com/mqtt` on port 443.
2. Supabase JWT validation.
3. Admin/user topic ACL.
4. Device ownership checks.
5. Node-RED request/response flows.
6. HTTPS storage for package bundles and user-uploaded media.
