-- Normalized device configuration (source of truth) + audit + sync state.
ALTER TABLE "User" ADD COLUMN "authSubject" TEXT;
CREATE UNIQUE INDEX "User_authSubject_key" ON "User"("authSubject");

CREATE TABLE "DeviceConfigHead" (
  "deviceDbId" TEXT NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 0,
  "systemConfig" JSONB NOT NULL DEFAULT '{}',
  "compiledConfig" JSONB NOT NULL DEFAULT '{}',
  "compiledSha256" TEXT,
  "updatedByUserId" TEXT,
  "updatedSource" TEXT NOT NULL DEFAULT 'system',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeviceConfigHead_pkey" PRIMARY KEY ("deviceDbId")
);

CREATE TABLE "DevicePageSettings" (
  "id" TEXT NOT NULL,
  "deviceDbId" TEXT NOT NULL,
  "pageSlug" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "pageRevision" BIGINT NOT NULL DEFAULT 0,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "position" INTEGER NOT NULL DEFAULT 0,
  "config" JSONB NOT NULL DEFAULT '{}',
  "updatedByUserId" TEXT,
  "updatedSource" TEXT NOT NULL DEFAULT 'system',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DevicePageSettings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DevicePageSettings_deviceDbId_pageSlug_key" ON "DevicePageSettings"("deviceDbId", "pageSlug");
CREATE INDEX "DevicePageSettings_deviceDbId_enabled_position_idx" ON "DevicePageSettings"("deviceDbId", "enabled", "position");

CREATE TABLE "DeviceConfigRevision" (
  "id" TEXT NOT NULL,
  "deviceDbId" TEXT NOT NULL,
  "globalRevision" BIGINT NOT NULL,
  "pageSlug" TEXT,
  "pageRevision" BIGINT,
  "changeType" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'system',
  "actorUserId" TEXT,
  "beforeConfig" JSONB,
  "afterConfig" JSONB,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeviceConfigRevision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DeviceConfigRevision_deviceDbId_createdAt_idx" ON "DeviceConfigRevision"("deviceDbId", "createdAt");

CREATE TABLE "DeviceSyncState" (
  "deviceDbId" TEXT NOT NULL,
  "desiredRevision" BIGINT NOT NULL DEFAULT 0,
  "reportedRevision" BIGINT NOT NULL DEFAULT 0,
  "reportedSha256" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "lastNotifiedAt" TIMESTAMP(3),
  "lastAppliedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeviceSyncState_pkey" PRIMARY KEY ("deviceDbId")
);

ALTER TABLE "DeviceConfigHead" ADD CONSTRAINT "DeviceConfigHead_deviceDbId_fkey" FOREIGN KEY ("deviceDbId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DevicePageSettings" ADD CONSTRAINT "DevicePageSettings_deviceDbId_fkey" FOREIGN KEY ("deviceDbId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceConfigRevision" ADD CONSTRAINT "DeviceConfigRevision_deviceDbId_fkey" FOREIGN KEY ("deviceDbId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceSyncState" ADD CONSTRAINT "DeviceSyncState_deviceDbId_fkey" FOREIGN KEY ("deviceDbId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
