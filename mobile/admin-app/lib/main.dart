import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'hub_api.dart';

void main() => runApp(const CcpAdminApp());

const ccpBg = Color(0xFF0B0E11);
const ccpPanel = Color(0xFF161B22);
const ccpAccent = Color(0xFFF0B90B);
const ccpMuted = Color(0xFF848E9C);
const ccpGreen = Color(0xFF0ECB81);
const ccpRed = Color(0xFFF6465D);

class CcpAdminApp extends StatelessWidget {
  const CcpAdminApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'CCP Admin',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark(useMaterial3: true).copyWith(
        scaffoldBackgroundColor: ccpBg,
        colorScheme: const ColorScheme.dark(primary: ccpAccent, surface: ccpPanel),
      ),
      home: const FleetScreen(),
    );
  }
}

class FleetScreen extends StatefulWidget {
  const FleetScreen({super.key});
  @override
  State<FleetScreen> createState() => _FleetScreenState();
}

class _FleetScreenState extends State<FleetScreen> {
  HubApi? _api;
  List<dynamic> _devices = [];
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _initApi();
  }

  Future<void> _initApi() async {
    final prefs = await SharedPreferences.getInstance();
    final base = prefs.getString('hub_url') ?? 'http://192.168.1.100:4000';
    setState(() => _api = HubApi(base));
    _refresh();
  }

  Future<void> _refresh() async {
    if (_api == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final devices = await _api!.listDevices();
      setState(() => _devices = devices);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      setState(() => _loading = false);
    }
  }

  Future<void> _editHubUrl() async {
    final prefs = await SharedPreferences.getInstance();
    final ctl = TextEditingController(text: prefs.getString('hub_url') ?? '');
    if (!mounted) return;
    final url = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Hub API URL'),
        content: TextField(
          controller: ctl,
          decoration: const InputDecoration(hintText: 'http://192.168.1.100:4000'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(c, ctl.text.trim()), child: const Text('Save')),
        ],
      ),
    );
    if (url != null && url.isNotEmpty) {
      await prefs.setString('hub_url', url);
      _initApi();
    }
  }

  Future<void> _sendCmd(String hwId, String type, [Map<String, dynamic>? params]) async {
    try {
      await _api!.sendCommand(hwId, type, params);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$type sent to $hwId')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  void _deviceActions(Map<String, dynamic> d) {
    final hwId = d['deviceId'] as String;
    showModalBottomSheet(
      context: context,
      backgroundColor: ccpPanel,
      builder: (c) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(title: Text(hwId, style: const TextStyle(color: ccpAccent))),
          ListTile(
              leading: const Icon(Icons.notifications_active),
              title: const Text('Identify (beep)'),
              onTap: () { Navigator.pop(c); _sendCmd(hwId, 'identify'); }),
          ListTile(
              leading: const Icon(Icons.sync),
              title: const Text('Reload UI'),
              onTap: () { Navigator.pop(c); _sendCmd(hwId, 'reload'); }),
          ListTile(
              leading: const Icon(Icons.restart_alt),
              title: const Text('Reboot'),
              onTap: () { Navigator.pop(c); _sendCmd(hwId, 'reboot'); }),
          ListTile(
              leading: const Icon(Icons.lock, color: ccpRed),
              title: const Text('Lock device'),
              onTap: () { Navigator.pop(c); _sendCmd(hwId, 'lock'); }),
          ListTile(
              leading: const Icon(Icons.lock_open),
              title: const Text('Unlock device'),
              onTap: () { Navigator.pop(c); _sendCmd(hwId, 'unlock'); }),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Fleet', style: TextStyle(color: ccpAccent, fontWeight: FontWeight.bold)),
        actions: [
          IconButton(onPressed: _editHubUrl, icon: const Icon(Icons.settings)),
          IconButton(onPressed: _refresh, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text('Cannot reach Hub API:\n$_error\n\nSet the URL via the gear icon.',
                      textAlign: TextAlign.center, style: const TextStyle(color: ccpMuted)),
                ))
              : RefreshIndicator(
                  onRefresh: _refresh,
                  child: ListView.separated(
                    padding: const EdgeInsets.all(12),
                    itemCount: _devices.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 8),
                    itemBuilder: (_, i) {
                      final d = _devices[i] as Map<String, dynamic>;
                      final online = d['online'] == true;
                      return Card(
                        color: ccpPanel,
                        child: ListTile(
                          leading: Icon(Icons.circle, size: 14, color: online ? ccpGreen : ccpMuted),
                          title: Text(d['name'] ?? d['deviceId'] ?? '?'),
                          subtitle: Text(
                            'fw ${d['fwVersion'] ?? '-'} · ${d['ip'] ?? '-'}'
                            '${d['battMv'] != null ? ' · ${d['battMv']}mV' : ''}',
                            style: const TextStyle(color: ccpMuted),
                          ),
                          trailing: const Icon(Icons.more_vert),
                          onTap: () => _deviceActions(d),
                        ),
                      );
                    },
                  ),
                ),
    );
  }
}
