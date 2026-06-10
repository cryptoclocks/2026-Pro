import 'dart:convert';
import 'package:http/http.dart' as http;

/// Thin client for the display's LAN API (see docs/manual.md §5).
class DeviceApi {
  final String host;
  DeviceApi(this.host);

  Uri _u(String path) => Uri.parse('http://$host$path');

  Future<Map<String, dynamic>> info() async {
    final res = await http.get(_u('/api/v1/info')).timeout(const Duration(seconds: 5));
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> getConfig() async {
    final res = await http.get(_u('/api/v1/config')).timeout(const Duration(seconds: 5));
    return jsonDecode(res.body.isEmpty ? '{}' : res.body) as Map<String, dynamic>;
  }

  Future<void> setConfig(Map<String, dynamic> config) async {
    await http.post(_u('/api/v1/config'),
        headers: {'Content-Type': 'application/json'}, body: jsonEncode(config));
  }

  Future<void> setBrightness(int value) async {
    await http.post(_u('/api/v1/brightness'), body: jsonEncode({'value': value}));
  }

  Future<void> identify() => http.post(_u('/api/v1/identify'));

  Future<void> wifiReset() => http.post(_u('/api/v1/wifi/reset'));
}
