-- Entitlements are now per-device (per CryptoClock), not per-user.
DROP INDEX IF EXISTS "Entitlement_userId_itemId_key";
ALTER TABLE "Entitlement" ADD COLUMN "deviceId" TEXT NOT NULL;
CREATE UNIQUE INDEX "Entitlement_deviceId_itemId_key" ON "Entitlement"("deviceId", "itemId");
CREATE INDEX "Entitlement_userId_idx" ON "Entitlement"("userId");
CREATE INDEX "Entitlement_deviceId_idx" ON "Entitlement"("deviceId");
