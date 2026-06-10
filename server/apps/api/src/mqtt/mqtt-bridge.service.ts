import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { connect, MqttClient } from "mqtt";
import { nanoid } from "nanoid";
import {
  DeviceCommand,
  DeviceCommandType,
  DeviceStatus,
  DeviceTelemetry,
  deviceIdFromTopic,
  mqttTopics,
} from "@ccp/shared";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Long-lived MQTT bridge: mirrors device status/telemetry into Postgres and
 * exposes sendCommand() for the REST layer, the Stripe webhook flow and the
 * (M7) ad scheduler.
 */
@Injectable()
export class MqttBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MqttBridgeService.name);
  private client?: MqttClient;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const url = process.env.MQTT_URL ?? "mqtt://localhost:1883";
    this.client = connect(url, {
      username: process.env.MQTT_API_USERNAME,
      password: process.env.MQTT_API_PASSWORD,
      clientId: `ccp-api-${nanoid(6)}`,
      reconnectPeriod: 3000,
    });

    this.client.on("connect", () => {
      this.log.log(`MQTT connected: ${url}`);
      this.client?.subscribe([
        mqttTopics.allStatus,
        mqttTopics.allTelemetry,
        mqttTopics.allCmdRes,
        mqttTopics.allImpressions,
      ]);
    });

    this.client.on("message", (topic, payload) => {
      this.handleMessage(topic, payload).catch((err) =>
        this.log.error(`message handling failed for ${topic}: ${err}`),
      );
    });

    this.client.on("error", (err) => this.log.warn(`MQTT error: ${err.message}`));
  }

  onModuleDestroy() {
    this.client?.end(true);
  }

  /** Publish a command to one device; resolves with the correlation id. */
  sendCommand(deviceId: string, type: DeviceCommandType, params?: Record<string, unknown>): string {
    const cmd: DeviceCommand = { id: nanoid(10), type, params };
    this.client?.publish(mqttTopics.cmd(deviceId), JSON.stringify(cmd), { qos: 1 });
    this.log.debug(`cmd ${type} -> ${deviceId} (${cmd.id})`);
    return cmd.id;
  }

  /** Push real-time data to a device's subscribed stream. */
  publishData(deviceId: string, stream: string, data: unknown): void {
    this.client?.publish(mqttTopics.data(deviceId, stream), JSON.stringify(data), { qos: 0 });
  }

  private async handleMessage(topic: string, payload: Buffer): Promise<void> {
    const deviceId = deviceIdFromTopic(topic);
    if (!deviceId) {
      return;
    }

    if (topic.endsWith("/status")) {
      const status = JSON.parse(payload.toString()) as DeviceStatus;
      await this.prisma.device.updateMany({
        where: { deviceId },
        data: {
          online: status.online ?? false,
          fwVersion: status.fw,
          ip: status.ip,
          rssi: status.rssi,
          locked: status.locked ?? undefined,
          lastSeenAt: new Date(),
        },
      });
    } else if (topic.endsWith("/telemetry")) {
      const t = JSON.parse(payload.toString()) as DeviceTelemetry;
      await this.prisma.device.updateMany({
        where: { deviceId },
        data: {
          battMv: t.batt_mv,
          fps: t.fps,
          sdFreeKb: t.sd_free_kb !== undefined ? BigInt(t.sd_free_kb) : undefined,
          lastSeenAt: new Date(),
          online: true,
        },
      });
    } else if (topic.endsWith("/ads/impression")) {
      const imp = JSON.parse(payload.toString()) as {
        campaign_id: string;
        ts: number;
        dur_ms?: number;
      };
      const device = await this.prisma.device.findUnique({ where: { deviceId } });
      if (device) {
        await this.prisma.adImpression.create({
          data: {
            campaignId: imp.campaign_id,
            deviceId: device.id,
            shownAt: new Date(imp.ts * 1000),
            durationMs: imp.dur_ms ?? 0,
          },
        });
      }
    } else if (topic.endsWith("/cmd/res")) {
      this.log.debug(`cmd/res from ${deviceId}: ${payload.toString()}`);
    }
  }
}
