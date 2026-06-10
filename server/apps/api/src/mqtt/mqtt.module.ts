import { Global, Module } from "@nestjs/common";
import { MqttBridgeService } from "./mqtt-bridge.service";

@Global()
@Module({
  providers: [MqttBridgeService],
  exports: [MqttBridgeService],
})
export class MqttModule {}
