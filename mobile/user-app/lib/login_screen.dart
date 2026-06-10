import 'package:flutter/material.dart';
import 'auth.dart';
import 'main.dart' show ccpAccent, ccpMuted;

/// Email OTP login. Pops with the verified email, or null if cancelled.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _emailCtl = TextEditingController();
  final _codeCtl = TextEditingController();
  bool _codeSent = false;
  bool _busy = false;
  String? _error;

  Future<void> _sendCode() async {
    final email = _emailCtl.text.trim();
    if (!email.contains('@')) {
      setState(() => _error = 'Enter a valid email');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await AuthService.requestOtp(email);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _codeSent = err == null;
      _error = err;
    });
  }

  Future<void> _verify() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final email =
        await AuthService.verifyOtp(_emailCtl.text.trim(), _codeCtl.text.trim());
    if (!mounted) return;
    if (email != null) {
      Navigator.pop(context, email);
    } else {
      setState(() {
        _busy = false;
        _error = 'Wrong or expired code — try again';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
          title: const Text('Login', style: TextStyle(color: ccpAccent))),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Icon(Icons.lock_open, size: 56, color: ccpAccent),
            const SizedBox(height: 8),
            const Text(
              'Login to unlock Price Alerts\non your CryptoClock',
              textAlign: TextAlign.center,
              style: TextStyle(color: ccpMuted),
            ),
            const SizedBox(height: 20),
            TextField(
              controller: _emailCtl,
              enabled: !_codeSent,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(
                labelText: 'Email',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
            const SizedBox(height: 12),
            if (_codeSent) ...[
              TextField(
                controller: _codeCtl,
                keyboardType: TextInputType.number,
                maxLength: 6,
                decoration: const InputDecoration(
                  labelText: '6-digit code from your email',
                  counterText: '',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
              const SizedBox(height: 12),
            ],
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(_error!,
                    style: const TextStyle(color: Colors.redAccent)),
              ),
            FilledButton(
              onPressed: _busy ? null : (_codeSent ? _verify : _sendCode),
              child: Text(_busy
                  ? 'Please wait...'
                  : (_codeSent ? 'Verify code' : 'Send code to email')),
            ),
            if (_codeSent)
              TextButton(
                onPressed: _busy
                    ? null
                    : () => setState(() {
                          _codeSent = false;
                          _codeCtl.clear();
                        }),
                child: const Text('Use a different email'),
              ),
          ],
        ),
      ),
    );
  }
}
