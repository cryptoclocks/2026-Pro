-- DropForeignKey
ALTER TABLE "MarketplaceItem" DROP CONSTRAINT "MarketplaceItem_authorId_fkey";

-- DropForeignKey
ALTER TABLE "MarketplaceItem" DROP CONSTRAINT "MarketplaceItem_payloadId_fkey";

-- CreateTable
CREATE TABLE "PageSettingSchema" (
    "pageSlug" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "packageId" TEXT,
    "jsonSchema" JSONB NOT NULL,
    "uiSchema" JSONB NOT NULL DEFAULT '{}',
    "defaultConfig" JSONB NOT NULL DEFAULT '{}',
    "assetSlots" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageSettingSchema_pkey" PRIMARY KEY ("pageSlug","schemaVersion")
);

-- CreateIndex
CREATE INDEX "PageSettingSchema_pageSlug_createdAt_idx" ON "PageSettingSchema"("pageSlug", "createdAt");

-- AddForeignKey
ALTER TABLE "MarketplaceItem" ADD CONSTRAINT "MarketplaceItem_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceItem" ADD CONSTRAINT "MarketplaceItem_payloadId_fkey" FOREIGN KEY ("payloadId") REFERENCES "Payload"("id") ON DELETE SET NULL ON UPDATE CASCADE;
