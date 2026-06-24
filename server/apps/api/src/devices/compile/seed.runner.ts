/* Standalone runner: seeds PageSettingSchema v1 for all native pages.
 * Usage: pnpm exec ts-node src/devices/compile/seed.runner.ts */
import { PrismaClient } from "@prisma/client";
import { seedPageSchemas } from "./page-schemas.seed";

async function main() {
  const prisma = new PrismaClient();
  try {
    const r = await seedPageSchemas(prisma);
    console.log(`PageSettingSchema seed: inserted=${r.inserted} skipped=${r.skipped}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
