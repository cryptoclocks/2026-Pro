import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'secrets.dart';

/// Client for the CryptoClock Pro Hub (cloud), authenticated with the
/// Supabase access token saved at login.
class HubApi {
  static Future<String?> _token() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('ccp_access_token');
  }

  /// Submit an optional per-page feature (e.g. crypto alerts) for manual
  /// admin approval. Returns null on success, an error string otherwise.
  static Future<String?> requestFeature({
    required String deviceId,
    required String page,
    required String feature,
    required Map<String, dynamic> detail,
  }) async {
    final token = await _token();
    if (token == null) return 'Please login first';
    try {
      final res = await http
          .post(
            Uri.parse('$hubBaseUrl/api/v1/me/feature-requests'),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $token',
            },
            body: jsonEncode({
              'deviceId': deviceId,
              'page': page,
              'feature': feature,
              'detail': detail,
            }),
          )
          .timeout(const Duration(seconds: 15));
      if (res.statusCode >= 300) return 'HTTP ${res.statusCode}: ${res.body}';
      return null;
    } catch (e) {
      return '$e';
    }
  }
}
