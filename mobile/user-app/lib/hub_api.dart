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

  static Map<String, String> _headers(String token) => {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      };

  /// The public catalog (pages + features) with prices.
  static Future<List<Map<String, dynamic>>> catalog() async {
    try {
      final res = await http
          .get(Uri.parse('$hubBaseUrl/api/v1/store/items'))
          .timeout(const Duration(seconds: 10));
      return (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
    } catch (_) {
      return [];
    }
  }

  /// Entitlement slugs this specific device holds.
  static Future<List<String>> deviceEntitlements(String deviceId) async {
    try {
      final res = await http
          .get(Uri.parse('$hubBaseUrl/api/v1/devices/$deviceId/entitlements'))
          .timeout(const Duration(seconds: 10));
      return (jsonDecode(res.body) as List).cast<String>();
    } catch (_) {
      return [];
    }
  }

  /// Start a Stripe checkout to unlock an item for ONE device.
  /// Returns {url} to open, {configured:false}, or {error}.
  static Future<Map<String, dynamic>> checkout(String slug, String deviceId) async {
    final token = await _token();
    if (token == null) return {'error': 'Please login first'};
    try {
      final res = await http
          .post(Uri.parse('$hubBaseUrl/api/v1/store/checkout'),
              headers: _headers(token),
              body: jsonEncode({'slug': slug, 'deviceId': deviceId}))
          .timeout(const Duration(seconds: 15));
      return jsonDecode(res.body) as Map<String, dynamic>;
    } catch (e) {
      return {'error': '$e'};
    }
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
