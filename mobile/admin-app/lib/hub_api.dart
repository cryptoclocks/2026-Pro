import 'dart:convert';
import 'package:http/http.dart' as http;

/// Client for the CryptoClock Pro Hub API (NestJS, /api/v1).
/// Auth (JWT) arrives with milestone M5 — dev builds talk to a local Hub.
class HubApi {
  final String baseUrl;
  HubApi(this.baseUrl);

  Uri _u(String path) => Uri.parse('$baseUrl/api/v1$path');

  Future<List<dynamic>> listDevices({String userId = 'admin'}) async {
    final res = await http
        .get(_u('/devices?userId=$userId'))
        .timeout(const Duration(seconds: 8));
    if (res.statusCode != 200) {
      throw Exception('HTTP ${res.statusCode}');
    }
    return jsonDecode(res.body) as List<dynamic>;
  }

  Future<String> sendCommand(String hwDeviceId, String type,
      [Map<String, dynamic>? params]) async {
    final res = await http.post(
      _u('/devices/$hwDeviceId/cmd'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'type': type, if (params != null) 'params': params}),
    );
    if (res.statusCode >= 300) {
      throw Exception('HTTP ${res.statusCode}: ${res.body}');
    }
    return (jsonDecode(res.body) as Map<String, dynamic>)['cmdId'] as String;
  }

  Future<void> assignPayload(String deviceDbId, String payloadVersionId) async {
    final res = await http.post(
      _u('/devices/$deviceDbId/assign'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'payloadVersionId': payloadVersionId}),
    );
    if (res.statusCode >= 300) {
      throw Exception('HTTP ${res.statusCode}: ${res.body}');
    }
  }
}
