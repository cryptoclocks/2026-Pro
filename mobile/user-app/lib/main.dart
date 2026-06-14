import 'package:flutter/material.dart';
import 'device_api.dart';
import 'discovery.dart';
import 'device_screen.dart';
import 'auth.dart';
import 'login_screen.dart';

void main() => runApp(const CcpUserApp());

const ccpBg = Color(0xFF0B0E11);
const ccpPanel = Color(0xFF161B22);
const ccpAccent = Color(0xFFF0B90B);
const ccpMuted = Color(0xFF848E9C);

class CcpUserApp extends StatelessWidget {
  const CcpUserApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'CryptoClock Pro',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark(useMaterial3: true).copyWith(
        scaffoldBackgroundColor: ccpBg,
        colorScheme: const ColorScheme.dark(
          primary: ccpAccent,
          surface: ccpPanel,
        ),
      ),
      home: const AuthGate(),
    );
  }
}

/// Login gate: on launch, show the discovery screen if already signed in,
/// otherwise the welcome screen (sign in required before using the app).
class AuthGate extends StatefulWidget {
  const AuthGate({super.key});
  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  bool? _authed; // null = still checking

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    final email = await AuthService.savedEmail();
    if (mounted) setState(() => _authed = email != null);
  }

  @override
  Widget build(BuildContext context) {
    if (_authed == null) {
      return const Scaffold(
        backgroundColor: ccpBg,
        body: Center(child: CircularProgressIndicator(color: ccpAccent)),
      );
    }
    if (_authed!) return const DiscoveryScreen();
    return WelcomeScreen(onSignedIn: () => setState(() => _authed = true));
  }
}

/// First-run welcome: branding + a single "Sign in" CTA. The app is unusable
/// until the user authenticates (email OTP or Google).
class WelcomeScreen extends StatelessWidget {
  final VoidCallback onSignedIn;
  const WelcomeScreen({super.key, required this.onSignedIn});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: ccpBg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              Center(
                child: Container(
                  width: 104,
                  height: 104,
                  decoration: BoxDecoration(
                    color: ccpPanel,
                    shape: BoxShape.circle,
                    border: Border.all(color: ccpAccent, width: 2),
                  ),
                  child: const Icon(Icons.watch, size: 52, color: ccpAccent),
                ),
              ),
              const SizedBox(height: 28),
              const Text('CryptoClock Pro',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: ccpAccent, fontSize: 30, fontWeight: FontWeight.bold)),
              const SizedBox(height: 12),
              const Text(
                'Set up and control your crypto display.\nSign in to manage your CryptoClock.',
                textAlign: TextAlign.center,
                style: TextStyle(color: ccpMuted, fontSize: 15, height: 1.4),
              ),
              const Spacer(),
              FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                onPressed: () async {
                  final email = await Navigator.push<String>(
                    context,
                    MaterialPageRoute(builder: (_) => const LoginScreen()),
                  );
                  if (email != null) onSignedIn();
                },
                child: const Text('Sign in to get started', style: TextStyle(fontSize: 16)),
              ),
              const SizedBox(height: 20),
            ],
          ),
        ),
      ),
    );
  }
}

/// Scan the LAN for displays (mDNS _ccp._tcp) or add one by IP.
class DiscoveryScreen extends StatefulWidget {
  const DiscoveryScreen({super.key});
  @override
  State<DiscoveryScreen> createState() => _DiscoveryScreenState();
}

class _DiscoveryScreenState extends State<DiscoveryScreen> {
  final List<DiscoveredDevice> _devices = [];
  bool _scanning = false;
  final _ipController = TextEditingController();

  Future<void> _scan() async {
    setState(() {
      _scanning = true;
      _devices.clear();
    });
    try {
      await for (final d in discoverDevices()) {
        if (!_devices.any((e) => e.host == d.host)) {
          setState(() => _devices.add(d));
        }
      }
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  Future<void> _openByIp(String ip) async {
    final api = DeviceApi(ip);
    try {
      final info = await api.info();
      if (!mounted) return;
      Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => DeviceScreen(api: api, info: info)),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Cannot reach device at $ip: $e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('CryptoClock Pro',
            style: TextStyle(color: ccpAccent, fontWeight: FontWeight.bold)),
        backgroundColor: ccpBg,
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            FilledButton.icon(
              onPressed: _scanning ? null : _scan,
              icon: _scanning
                  ? const SizedBox(
                      width: 16, height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.wifi_find),
              label: Text(_scanning ? 'Scanning...' : 'Scan for displays'),
            ),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(
                child: TextField(
                  controller: _ipController,
                  decoration: const InputDecoration(
                    hintText: 'or enter device IP (192.168.1.x)',
                    isDense: true,
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filledTonal(
                onPressed: () => _openByIp(_ipController.text.trim()),
                icon: const Icon(Icons.arrow_forward),
              ),
            ]),
            const SizedBox(height: 16),
            Expanded(
              child: _devices.isEmpty
                  ? const Center(
                      child: Text(
                        'No displays found yet.\n\nNew device? Join its WiFi\n"CCP-Setup-XXXX" and open\nhttp://192.168.4.1 to set up WiFi first.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: ccpMuted),
                      ),
                    )
                  : ListView.separated(
                      itemCount: _devices.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 8),
                      itemBuilder: (_, i) {
                        final d = _devices[i];
                        return Card(
                          color: ccpPanel,
                          child: ListTile(
                            leading: const Icon(Icons.watch, color: ccpAccent),
                            title: Text(d.name),
                            subtitle: Text(d.host,
                                style: const TextStyle(color: ccpMuted)),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => _openByIp(d.host),
                          ),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
