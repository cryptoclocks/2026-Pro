import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'secrets.dart';

/// Minimal Supabase email-OTP auth (REST, no SDK needed).
/// Flow: requestOtp(email) -> user reads 6-digit code from email
///       -> verifyOtp(email, code) -> session saved locally.
class AuthService {
  static Map<String, String> get _headers => {
        'apikey': supabaseAnonKey,
        'Content-Type': 'application/json',
      };

  /// Returns null on success, error message otherwise.
  static Future<String?> requestOtp(String email) async {
    try {
      final res = await http
          .post(Uri.parse('$supabaseUrl/auth/v1/otp'),
              headers: _headers,
              body: jsonEncode({'email': email, 'create_user': true}))
          .timeout(const Duration(seconds: 15));
      if (res.statusCode >= 400) {
        final msg = jsonDecode(res.body);
        return '${msg['msg'] ?? msg['error_description'] ?? res.body}';
      }
      return null;
    } catch (e) {
      return '$e';
    }
  }

  /// Returns the verified email on success, null on failure.
  static Future<String?> verifyOtp(String email, String code) async {
    try {
      final res = await http
          .post(Uri.parse('$supabaseUrl/auth/v1/verify'),
              headers: _headers,
              body: jsonEncode({'type': 'email', 'email': email, 'token': code}))
          .timeout(const Duration(seconds: 15));
      if (res.statusCode >= 400) return null;
      final json = jsonDecode(res.body) as Map<String, dynamic>;
      final userEmail = (json['user']?['email'] as String?) ?? email;
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('ccp_email', userEmail);
      await prefs.setString('ccp_access_token', json['access_token'] as String? ?? '');
      return userEmail;
    } catch (_) {
      return null;
    }
  }

  static Future<String?> savedEmail() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('ccp_email');
  }

  static Future<void> signOut() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('ccp_email');
    await prefs.remove('ccp_access_token');
  }
}
