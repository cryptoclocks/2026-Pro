# Device Identity, Factory Registry, and Customer Claim Plan

## Recommended identity model

Keep these values separate:

| Field | Example | Purpose |
|---|---|---|
| `serialNumber` | `CCP-000001` | Human-facing label, order, warranty, and support |
| `macAddress` | `98:3D:AE:E9:14:78` | Immutable hardware identity |
| `deviceId` | `ccp-983daee91478` | Stable API/database key derived from MAC |
| `mqttTopicId` | opaque hex value | MQTT routing; never used as a customer-facing serial |

Do not replace `deviceId` with `CCP-000001 + MAC`. A sequential number requires
a central allocator and must be written during factory provisioning, while a MAC
can be derived independently by every unit. Combining both makes identifiers
longer without adding useful uniqueness and couples MQTT routing to factory
labels.

Existing units must retain their current `deviceId` and MQTT addressing. Add
`serialNumber` as a new field; do not migrate old topic names destructively.

## Factory workflow

1. Flash the production firmware.
2. A factory tool reads the Wi-Fi station MAC over serial.
3. The tool requests the next serial number from the Hub API, for example
   `CCP-000001`.
4. The Hub creates an unowned device record and a random, single-use claim
   secret.
5. The factory tool writes `serialNumber` into NVS and prints a label/QR:
   `https://2026-pro-user.vercel.app/claim/<single-use-secret>`.
6. The Google Sheet receives a non-secret operational copy of the device row.

The API/Postgres database is the source of truth. Google Sheets is for sales,
support, fulfillment, and manually entered customer notes.

Never store MQTT tokens, JWTs, database credentials, or the full claim secret in
Google Sheets.

## Customer registration (recommended UX)

1. Customer opens the QR link.
2. The web app requires Google Sign-In.
3. The page shows the serial number and asks the customer to confirm
   **Add this CryptoClock**.
4. The API atomically validates the unused claim secret, attaches the signed-in
   user as owner, marks the claim used, and mints the device token.
5. The device polls the Hub using its factory claim identity and stores the
   returned token in NVS.
6. The web app opens the newly registered device automatically.

This avoids asking customers to type a MAC address or device ID.

## Required security fixes before public claim

The current `POST /devices/claim` implementation accepts `code` but does not
validate it, and its upsert can replace an existing owner. Do not expose that
flow publicly until all of these rules are implemented:

- claim records must be pre-created by the factory/admin;
- claim secrets must be random, single-use, and expire or be revocable;
- the submitted secret must match the pending device;
- a device owned by another user cannot be reassigned through normal claim;
- owner transfer must be a separate audited admin/owner action;
- device tokens are returned only through the device provisioning channel;
- every claim/transfer is written to an audit log.

## Google Sheet columns

Recommended operational columns:

- Serial Number
- Batch
- MAC Address
- Device ID
- Model
- Factory Date
- Factory Status
- Initial Firmware
- Current Firmware
- Claim Status
- Claimed At
- Owner Google Email
- Customer Name
- Order Number
- Sales Channel
- Purchase Date
- Warranty End
- Shipping Tracking
- Last Seen
- Support Status
- Notes

Secrets must stay in the Hub database, not in this sheet.

## Suggested implementation phases

1. Add `serialNumber`, `macAddress`, `batch`, and factory metadata to the Hub
   database.
2. Add an admin-only batch/factory registration endpoint.
3. Replace the current claim logic with validated, single-use claims.
4. Add the QR claim page to `web-user`.
5. Add the device-side claim poll/token storage flow.
6. Sync non-secret registry fields to Google Sheets.
