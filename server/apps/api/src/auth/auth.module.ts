import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SupabaseService } from "./supabase.service";
import { UserGuard, AdminGuard } from "./auth.guards";
import { AuthController } from "./auth.controller";

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [SupabaseService, UserGuard, AdminGuard],
  exports: [SupabaseService, UserGuard, AdminGuard],
})
export class AuthModule {}
