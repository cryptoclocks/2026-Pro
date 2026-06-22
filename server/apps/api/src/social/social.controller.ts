import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { UserGuard } from "../auth/auth.guards";
import { SocialService } from "./social.service";

@Controller("social")
@UseGuards(UserGuard)
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Post("resolve")
  resolve(@Body() body: { url: string; platform?: "facebook" | "youtube" | "tiktok" | "instagram" | "unknown" }) {
    return this.social.resolve(body.url, body.platform);
  }

  @Post("parse")
  parse(@Body() body: { url: string; html: string; platform?: "facebook" | "youtube" | "tiktok" | "instagram" | "unknown" }) {
    return this.social.parseProvidedHtml(body.url, body.html ?? "", body.platform);
  }
}
