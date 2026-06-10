/** MQTT topic helpers — single source of truth for both API and tools. */

export const mqttTopics = {
  cmd: (deviceId: string) => `ccp/v1/${deviceId}/cmd`,
  cmdRes: (deviceId: string) => `ccp/v1/${deviceId}/cmd/res`,
  status: (deviceId: string) => `ccp/v1/${deviceId}/status`,
  telemetry: (deviceId: string) => `ccp/v1/${deviceId}/telemetry`,
  data: (deviceId: string, stream: string) => `ccp/v1/${deviceId}/data/${stream}`,
  evt: (deviceId: string, name: string) => `ccp/v1/${deviceId}/evt/${name}`,
  adImpression: (deviceId: string) => `ccp/v1/${deviceId}/ads/impression`,
  /** wildcard subscriptions for the API bridge */
  allStatus: "ccp/v1/+/status",
  allTelemetry: "ccp/v1/+/telemetry",
  allCmdRes: "ccp/v1/+/cmd/res",
  allEvents: "ccp/v1/+/evt/+",
  allImpressions: "ccp/v1/+/ads/impression",
} as const;

export type DeviceCommandType =
  | "sync" | "reload" | "ota" | "reboot" | "brightness"
  | "identify" | "lock" | "unlock" | "wipe" | "show_page" | "notify" | "ping"
  | "settings";

export interface DeviceCommand {
  id: string;
  type: DeviceCommandType;
  params?: Record<string, unknown>;
}

export interface SyncCommandParams {
  package_id: string;
  version: string;
  bundle_url: string;
  bundle_sha256: string;
  bundle_size?: number;
}

export interface DeviceStatus {
  online: boolean;
  fw?: string;
  pkg?: string;
  pkg_ver?: string;
  ip?: string;
  rssi?: number;
  streams?: string[];
  locked?: boolean;
}

export interface DeviceTelemetry {
  heap?: number;
  heap_min?: number;
  psram?: number;
  batt_mv?: number;
  fps?: number;
  uptime_s?: number;
  sd_free_kb?: number;
  wasm_crashes?: number;
}

export const deviceIdFromTopic = (topic: string): string | null => {
  const m = topic.match(/^ccp\/v1\/([^/]+)\//);
  return m ? m[1] : null;
};
