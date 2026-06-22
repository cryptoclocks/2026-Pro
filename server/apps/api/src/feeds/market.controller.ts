import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";

const SYMBOL_RE = /^[A-Z0-9]{5,12}$/;
const INTERVAL_RE = /^\d+[mhdw]$/;

@Controller("market")
export class MarketController {
  @Get(":symbol/ticker24h")
  async ticker24h(@Param("symbol") symbol: string) {
    const safeSymbol = this.safeSymbol(symbol);
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${safeSymbol}`);
    if (!res.ok) {
      throw new BadRequestException(`binance ${res.status}`);
    }
    return res.json();
  }

  @Get(":symbol/klines/:interval")
  async klines(
    @Param("symbol") symbol: string,
    @Param("interval") interval: string,
    @Query("limit") limit?: string,
  ) {
    const safeSymbol = this.safeSymbol(symbol);
    const safeInterval = this.safeInterval(interval);
    const n = Math.min(Math.max(Number(limit) || 60, 1), 120);
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${safeSymbol}&interval=${safeInterval}&limit=${n}`,
    );
    if (!res.ok) {
      throw new BadRequestException(`binance ${res.status}`);
    }
    return res.json();
  }

  private safeSymbol(symbol: string) {
    const upper = symbol.toUpperCase();
    if (!SYMBOL_RE.test(upper)) {
      throw new BadRequestException("invalid symbol");
    }
    return upper;
  }

  private safeInterval(interval: string) {
    if (!INTERVAL_RE.test(interval)) {
      throw new BadRequestException("invalid interval");
    }
    return interval;
  }
}
