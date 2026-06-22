import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { connect, MqttClient } from "mqtt";
import { createCipheriv } from "node:crypto";
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
/** encId = AES-128-CBC(plain, key=iv "ClocktoCrypt1234", PKCS7, lowercase hex) —
 *  same scheme as the firmware (cc_aes) and the Node-RED bridge. */
function ccpAes(plain: string): string {
  const key = Buffer.from("ClocktoCrypt1234");
  const c = createCipheriv("aes-128-cbc", key, key);
  c.setAutoPadding(true);
  return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("hex");
}

@Injectable()
export class MqttBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MqttBridgeService.name);
  private client?: MqttClient;
  /** learned from retained status (which carries id): deviceId <-> encId topic. */
  private readonly idToEnc = new Map<string, string>();
  private readonly encToId = new Map<string, string>();

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
    const body = JSON.stringify(cmd);
    // Address by the learned encId (AES(id-MAC)), the AES(id) form, and the
    // plaintext id topic — so legacy and re-flashed firmware all receive it.
    const topics = new Set<string>();
    const enc = this.idToEnc.get(deviceId);
    if (enc) topics.add(`ccp/v1/${enc}/cmd`);
    topics.add(`ccp/v1/${ccpAes(deviceId)}/cmd`);
    topics.add(mqttTopics.cmd(deviceId));
    for (const t of topics) this.client?.publish(t, body, { qos: 1 });
    this.log.debug(`cmd ${type} -> ${deviceId} (${cmd.id}) [${topics.size} topics]`);
    return cmd.id;
  }

  /** Push real-time data to a device's subscribed stream. */
  publishData(deviceId: string, stream: string, data: unknown): void {
    this.client?.publish(mqttTopics.data(deviceId, stream), JSON.stringify(data), { qos: 0 });
  }

  private async handleMessage(topic: string, payload: Buffer): Promise<void> {
    // For re-flashed firmware the topic segment is the encId (hex); for legacy
    // it's the plaintext id. Status carries {id,mac} so we can map encId->id.
    const topicId = deviceIdFromTopic(topic);
    if (!topicId) {
      return;
    }

    if (topic.endsWith("/status")) {
      const status = JSON.parse(payload.toString()) as DeviceStatus & { id?: string; mac?: string };
      const deviceId = status.id || this.encToId.get(topicId) || topicId;
      if (status.id) {
        this.idToEnc.set(status.id, topicId);
        this.encToId.set(topicId, status.id);
      }
      await this.prisma.device.updateMany({
        where: { deviceId },
        data: {
          online: status.online ?? false,
          fwVersion: status.fw,
          ip: status.ip,
          rssi: status.rssi,
          locked: status.locked ?? undefined,
          mac: status.mac ?? undefined,
          lastSeenAt: new Date(),
        },
      });
    } else if (topic.endsWith("/telemetry")) {
      const t = JSON.parse(payload.toString()) as DeviceTelemetry;
      const deviceId = this.encToId.get(topicId) || topicId;
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
      const deviceId = this.encToId.get(topicId) || topicId;
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
      this.log.debug(`cmd/res from ${topicId}: ${payload.toString()}`);
    }
  }
}
