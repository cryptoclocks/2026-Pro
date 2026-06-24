-- CreateTable
CREATE TABLE "Firmware" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "notes" TEXT,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "objectPath" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Firmware_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Firmware_channel_createdAt_idx" ON "Firmware"("channel", "createdAt");
