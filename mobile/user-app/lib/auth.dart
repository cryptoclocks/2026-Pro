import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:google_sign_in/google_sign_in.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'secrets.dart';

/// Minimal Supabase auth (REST, no SDK needed).
/// Email OTP: requestOtp(email) -> user reads 6-digit code -> verifyOtp().
/// Google: signInWithGoogle() -> native account picker -> Supabase id_token grant.
class AuthService {
  static Map<String, String> get _headers => {
        'apikey': supabaseAnonKey,
        'Content-Type': 'application/json',
      };

  static Future<void> _saveSession(String email, String accessToken) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('ccp_email', email);
    await prefs.setString('ccp_access_token', accessToken);
  }

  /// Native "Sign in with Google": the OS account picker returns a Google
  /// idToken (audience = our Web client via serverClientId), which we exchange
  /// for a Supabase session through the id_token grant. Returns the verified
  /// email on success, null if the user cancelled; throws a message on failure.
  static Future<String?> signInWithGoogle() async {
    final google = GoogleSignIn(serverClientId: googleWebClientId, scopes: ['email']);
    final account = await google.signIn();
    if (account == null) return null; // user dismissed the picker
    final gAuth = await account.authentication;
    final idToken = gAuth.idToken;
    if (idToken == null) throw 'Google did not return an ID token';

    final res = await http
        .post(Uri.parse('$supabaseUrl/auth/v1/token?grant_type=id_token'),
            headers: _headers,
            body: jsonEncode({'provider': 'google', 'id_token': idToken}))
        .timeout(const Duration(seconds: 20));
    if (res.statusCode >= 400) {
      final m = jsonDecode(res.body);
      throw '${m['msg'] ?? m['error_description'] ?? m['error'] ?? res.body}';
    }
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    final userEmail = (json['user']?['email'] as String?) ?? account.email;
    await _saveSession(userEmail, json['access_token'] as String? ?? '');
    return userEmail;
  }

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
