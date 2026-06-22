import { BadRequestException, Injectable } from "@nestjs/common";

type Platform = "facebook" | "youtube" | "tiktok" | "instagram" | "unknown";

export interface SocialResolveResult {
  ok: boolean;
  platform: Platform;
  url: string;
  fetchedUrl?: string;
  source: "public-html" | "provided-html";
  status?: number;
  name?: string;
  description?: string;
  avatarUrl?: string;
  followers?: string;
  following?: string;
  likes?: string;
  talkingAbout?: string;
  secondaryLabel?: string;
  secondaryValue?: string;
  warning?: string;
}

const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 450_000;

@Injectable()
export class SocialService {
  async resolve(url: string, platformHint?: Platform): Promise<SocialResolveResult> {
    const safe = this.safeUrl(url);
    const platform = platformHint && platformHint !== "unknown" ? platformHint : this.inferPlatform(safe);
    const fetchUrl = platform === "facebook" ? this.facebookMobileUrl(safe) : safe.toString();
    const { status, html } = await this.fetchTopHtml(fetchUrl);
    const parsed = this.parseHtml(html, safe.toString(), platform, "public-html");
    return {
      ...parsed,
      ok: parsed.ok && status >= 200 && status < 300,
      status,
      fetchedUrl: fetchUrl,
      warning: status >= 200 && status < 300 ? parsed.warning : `Fetch returned HTTP ${status}`,
    };
  }

  parseProvidedHtml(url: string, html: string, platformHint?: Platform): SocialResolveResult {
    const safe = this.safeUrl(url);
    const platform = platformHint && platformHint !== "unknown" ? platformHint : this.inferPlatform(safe);
    return this.parseHtml(html.slice(0, MAX_HTML_BYTES), safe.toString(), platform, "provided-html");
  }

  private parseHtml(
    html: string,
    url: string,
    platform: Platform,
    source: "public-html" | "provided-html",
  ): SocialResolveResult {
    const meta = this.readMeta(html);
    const text = this.clean(html);
    const description = meta["og:description"] || meta.description || meta["twitter:description"];
    const name = this.titleFromHtml(html) || meta["og:title"] || meta["twitter:title"];
    const avatarUrl = meta["og:image"] || meta["twitter:image"] || this.firstSvgImage(html);
    const fromRendered = this.parseRenderedCounts(html);
    const fromDescription = this.parseDescriptionCounts(description || text);
    const followers = fromRendered.followers || fromDescription.followers;
    const following = fromRendered.following || fromDescription.following;
    const likes = fromDescription.likes;
    const talkingAbout = fromDescription.talkingAbout;
    const secondaryLabel = following ? "Following" : talkingAbout ? "Talking" : undefined;
    const secondaryValue = following || talkingAbout;

    return {
      ok: Boolean(name || avatarUrl || followers || following || likes || talkingAbout),
      platform,
      url,
      source,
      name,
      description,
      avatarUrl,
      followers: followers || likes,
      following,
      likes,
      talkingAbout,
      secondaryLabel,
      secondaryValue,
      warning: followers ? undefined : likes ? "Facebook mobile public HTML exposes likes, not exact follower count." : undefined,
    };
  }

  private async fetchTopHtml(url: string): Promise<{ status: number; html: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "accept": "text/html,application/xhtml+xml",
          "accept-language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        },
        redirect: "follow",
      });
      const raw = await res.arrayBuffer();
      const html = Buffer.from(raw).subarray(0, MAX_HTML_BYTES).toString("utf8");
      return { status: res.status, html };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`social fetch failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private safeUrl(input: string): URL {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new BadRequestException("invalid social url");
    }
    if (url.protocol !== "https:") {
      throw new BadRequestException("social url must be https");
    }
    const host = url.hostname.toLowerCase();
    const allowed =
      host === "youtu.be" ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "facebook.com" ||
      host.endsWith(".facebook.com") ||
      host === "instagram.com" ||
      host.endsWith(".instagram.com") ||
      host === "tiktok.com" ||
      host.endsWith(".tiktok.com");
    if (!allowed) {
      throw new BadRequestException("unsupported social host");
    }
    return url;
  }

  private inferPlatform(url: URL): Platform {
    const host = url.hostname.toLowerCase();
    if (host.includes("facebook.com")) return "facebook";
    if (host.includes("youtube.com") || host === "youtu.be") return "youtube";
    if (host.includes("tiktok.com")) return "tiktok";
    if (host.includes("instagram.com")) return "instagram";
    return "unknown";
  }

  private facebookMobileUrl(url: URL): string {
    return `https://m.facebook.com${url.pathname}${url.search}`;
  }

  private readMeta(html: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const match of html.matchAll(/<meta\s+[^>]*>/gi)) {
      const tag = match[0];
      const key = this.attr(tag, "property") || this.attr(tag, "name");
      const content = this.attr(tag, "content");
      if (key && content) out[key] = this.decode(content);
    }
    return out;
  }

  private attr(tag: string, name: string): string | undefined {
    const re = new RegExp(`${name}=["']([^"']+)["']`, "i");
    const m = tag.match(re);
    return m?.[1];
  }

  private titleFromHtml(html: string): string | undefined {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    if (h1) return this.clean(h1);
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    return title ? this.clean(title) : undefined;
  }

  private firstSvgImage(html: string): string | undefined {
    const src = html.match(/xlink:href=["']([^"']+)["']/i)?.[1];
    return src ? this.decode(src) : undefined;
  }

  private parseRenderedCounts(html: string): { followers?: string; following?: string } {
    const followers = html.match(/<strong[^>]*>([^<]+)<\/strong>\s*(?:followers|ผู้ติดตาม)/i)?.[1];
    const following = html.match(/<strong[^>]*>([^<]+)<\/strong>\s*(?:following|กำลังติดตาม)/i)?.[1];
    return {
      followers: followers ? this.normalizeCount(followers) : undefined,
      following: following ? this.normalizeCount(following) : undefined,
    };
  }

  private parseDescriptionCounts(text: string): {
    followers?: string;
    following?: string;
    likes?: string;
    talkingAbout?: string;
  } {
    const clean = this.decode(text).replace(/\s+/g, " ");
    const followers = clean.match(/([\d.,]+\s*[KMB]?)\s*(?:followers|ผู้ติดตาม)/i)?.[1];
    const following = clean.match(/([\d.,]+\s*[KMB]?)\s*(?:following|กำลังติดตาม)/i)?.[1];
    const likes = clean.match(/(?:ถูกใจ|likes?)\s*([\d.,]+\s*[KMB]?)/i)?.[1] || clean.match(/([\d.,]+\s*[KMB]?)\s*(?:likes?)/i)?.[1];
    const talkingAbout = clean.match(/([\d.,]+\s*[KMB]?)\s*คนกำลังพูดถึง/i)?.[1];
    return {
      followers: followers ? this.normalizeCount(followers) : undefined,
      following: following ? this.normalizeCount(following) : undefined,
      likes: likes ? this.normalizeCount(likes) : undefined,
      talkingAbout: talkingAbout ? this.normalizeCount(talkingAbout) : undefined,
    };
  }

  private normalizeCount(value: string): string {
    return value.replace(/\s+/g, "").trim();
  }

  private clean(value: string): string {
    return this.decode(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  }

  private decode(value: string): string {
    return value
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
  }
}
