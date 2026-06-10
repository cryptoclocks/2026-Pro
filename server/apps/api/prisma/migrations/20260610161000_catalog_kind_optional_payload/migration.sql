-- Catalog items can be PAGE or FEATURE; feature add-ons have no payload/author.
CREATE TYPE "CatalogKind" AS ENUM ('PAGE', 'FEATURE');
ALTER TABLE "MarketplaceItem"
  ADD COLUMN "kind" "CatalogKind" NOT NULL DEFAULT 'PAGE',
  ADD COLUMN "icon" TEXT,
  ALTER COLUMN "published" SET DEFAULT true;
-- make author/payload optional (system catalog items have neither)
ALTER TABLE "MarketplaceItem" ALTER COLUMN "authorId" DROP NOT NULL;
ALTER TABLE "MarketplaceItem" ALTER COLUMN "payloadId" DROP NOT NULL;
