"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import mqtt, { type MqttClient } from "mqtt";
import { useAuth } from "@/lib/auth";

type MqttState = "disabled" | "connecting" | "connected" | "offline" | "error";

interface MqttContextValue {
  state: MqttState;
  error: string | null;
  publishRequest: (operation: string, payload?: Record<string, unknown>) => Promise<string>;
}

const MqttContext = createContext<MqttContextValue>({
  state: "disabled",
  error: null,
  publishRequest: async () => {
    throw new Error("MQTT is not configured");
  },
});

export const useMqtt = () => useContext(MqttContext);

const MQTT_URL = process.env.NEXT_PUBLIC_MQTT_WS_URL ?? "";

export function MqttProvider({ children }: { children: ReactNode }) {
  const { token, me } = useAuth();
  const clientRef = useRef<MqttClient | null>(null);
  const [state, setState] = useState<MqttState>(MQTT_URL ? "offline" : "disabled");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!MQTT_URL || !token || !me?.isAdmin) {
      clientRef.current?.end(true);
      clientRef.current = null;
      setState(MQTT_URL ? "offline" : "disabled");
      return;
    }

    setState("connecting");
    setError(null);
    const client = mqtt.connect(MQTT_URL, {
      username: `web-admin:${me.id}`,
      password: token,
      clientId: `ccp-admin-${randomId()}`,
      clean: true,
      reconnectPeriod: 3000,
      connectTimeout: 10_000,
      protocolVersion: 4,
    });
    clientRef.current = client;

    client.on("connect", () => {
      setState("connected");
      setError(null);
      client.subscribe([
        `ccp/web/admin/${me.id}/response/#`,
        `ccp/web/admin/${me.id}/fleet/#`,
      ], { qos: 1 });
    });
    client.on("reconnect", () => setState("connecting"));
    client.on("offline", () => setState("offline"));
    client.on("close", () => setState("offline"));
    client.on("error", (err) => {
      setError(err.message);
      setState("error");
    });

    return () => {
      clientRef.current = null;
      client.end(true);
    };
  }, [token, me?.id, me?.isAdmin]);

  const value = useMemo<MqttContextValue>(() => ({
    state,
    error,
    publishRequest: async (operation, payload = {}) => {
      const client = clientRef.current;
      if (!client?.connected || !me?.id) {
        throw new Error("MQTT gateway is not connected");
      }
      const requestId = randomId();
      const topic = `ccp/web/admin/${me.id}/request/${requestId}`;
      const body = JSON.stringify({ id: requestId, operation, payload, sentAt: new Date().toISOString() });
      await new Promise<void>((resolve, reject) => {
        client.publish(topic, body, { qos: 1 }, (err) => err ? reject(err) : resolve());
      });
      return requestId;
    },
  }), [state, error, me?.id]);

  return <MqttContext.Provider value={value}>{children}</MqttContext.Provider>;
}

function randomId() {
  return globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 20)
    ?? Math.random().toString(36).slice(2, 14);
}
