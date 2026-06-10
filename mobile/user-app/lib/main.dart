import 'package:flutter/material.dart';
import 'device_api.dart';
import 'discovery.dart';
import 'device_screen.dart';

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
      home: const DiscoveryScreen(),
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
