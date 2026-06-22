-- Device provisioning: store MAC (for encId = AES("<deviceId>-<MAC>")) + claim code.
ALTER TABLE "Device"
  ADD COLUMN "mac" TEXT,
  ADD COLUMN "claimCode" TEXT;

-- Monotonic counter for the sequential CCP serial (e.g. id "device_ccp").
CREATE TABLE "Counter" (
  "id" TEXT NOT NULL,
  "value" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "Counter_pkey" PRIMARY KEY ("id")
);
