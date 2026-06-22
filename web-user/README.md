# CryptoClock Pro User Web

Browser version of the CryptoClock Pro user app. It supports two transports:

- Production HTTPS: settings and commands use the authenticated MQTT-over-WSS
  gateway.
- Local HTTP: direct LAN access to a display by IP remains available for
  development and same-WiFi maintenance.

Photo, avatar, and GIF files are intentionally not sent through MQTT. Until the
production signed-upload service exists, manage those files from the Flutter
mobile app on the same WiFi as the display.

## Local development

```bash
cp .env.example .env.local
pnpm install
pnpm dev
```

Open `http://localhost:8099`. HTTP local mode asks for the display IP.

## Production

Deploy this directory as its own Vercel project:

- Root Directory: `web-user`
- Domain: `ccp-user.cashlessthailand.com`
- Build Command: `pnpm build`
- Output Directory: `dist`

Set these Vercel variables:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-browser-publishable-key
VITE_HUB_BASE_URL=https://api.example.com
VITE_MQTT_WS_URL=wss://mqtt-ccp.cashlessthailand.com/mqtt
```

`VITE_*` values are included in the browser bundle. Use only Supabase's
publishable/anon key here. Never use `service_role`, database credentials,
Node-RED credentials, or an Aedes broker master password.

## MQTT RPC contract

The production app uses Google Sign-In through Supabase OAuth only. After
login, the browser connects with:

```text
username: web-user:<verified-user-id>
password: <Supabase access token>
```

Requests:

```text
ccp/web/user/<user-id>/request/<request-id>
```

Responses:

```text
ccp/web/user/<user-id>/response/<request-id>
```

Node-RED/the WSS gateway must verify the JWT and device ownership before
forwarding anything to `ccp/v1/<device-id>/cmd`.
