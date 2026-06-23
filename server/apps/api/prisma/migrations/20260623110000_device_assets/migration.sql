-- Per-device/page logical assets + immutable file versions (files on OCI volume).
CREATE TABLE "DeviceAsset" (
  "id" TEXT NOT NULL,
  "deviceDbId" TEXT NOT NULL,
  "pageSlug" TEXT NOT NULL,
  "assetKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'image',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER,
  "currentVersionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeviceAsset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeviceAsset_deviceDbId_pageSlug_assetKey_key" ON "DeviceAsset"("deviceDbId", "pageSlug", "assetKey");
CREATE INDEX "DeviceAsset_deviceDbId_pageSlug_idx" ON "DeviceAsset"("deviceDbId", "pageSlug");

CREATE TABLE "DeviceAssetVersion" (
  "id" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "objectPath" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "sha256" TEXT NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeviceAssetVersion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DeviceAssetVersion_assetId_idx" ON "DeviceAssetVersion"("assetId");

ALTER TABLE "DeviceAsset" ADD CONSTRAINT "DeviceAsset_deviceDbId_fkey" FOREIGN KEY ("deviceDbId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceAssetVersion" ADD CONSTRAINT "DeviceAssetVersion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "DeviceAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
