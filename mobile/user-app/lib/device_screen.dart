import 'package:flutter/material.dart';
import 'device_api.dart';
import 'device_controller.dart';
import 'settings_pages.dart';
import 'store_screen.dart';
import 'main.dart' show ccpAccent, ccpMuted, ccpPanel;

/// Hub for one display: a menu of per-area settings screens + the Store.
class DeviceScreen extends StatefulWidget {
  final DeviceApi api;
  final Map<String, dynamic> info;
  const DeviceScreen({super.key, required this.api, required this.info});

  @override
  State<DeviceScreen> createState() => _DeviceScreenState();
}

class _DeviceScreenState extends State<DeviceScreen> {
  late final DeviceController _c = DeviceController(widget.api, widget.info);

  @override
  void initState() {
    super.initState();
    _c.load();
  }

  void _open(Widget screen) {
    Navigator.push(context, MaterialPageRoute(builder: (_) => screen));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_c.deviceId, style: const TextStyle(color: ccpAccent)),
        actions: [
          IconButton(
            tooltip: 'Identify (beep)',
            onPressed: () => widget.api.identify(),
            icon: const Icon(Icons.notifications_active),
          ),
        ],
      ),
      body: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          if (!_c.loaded) {
            return const Center(child: CircularProgressIndicator());
          }
          final tiles = <_MenuTile>[
            _MenuTile(Icons.tune, 'System', 'Pages, brightness, mode, WiFi',
                () => _open(SystemSettings(_c))),
            _MenuTile(Icons.person, 'Profile', 'Photo, name, colours, social',
                () => _open(ProfileSettings(_c))),
            _MenuTile(Icons.schedule, 'Clock', '24/12h, date, colours, alarm',
                () => _open(ClockSettings(_c))),
            _MenuTile(Icons.show_chart, 'Crypto', 'Coins, chart, alerts',
                () => _open(CryptoSettings(_c))),
            _MenuTile(Icons.photo_library, 'Photo slideshow',
                'Upload, order, effect', () => _open(PhotosSettings(_c))),
            _MenuTile(Icons.storefront, 'Store', 'Add more pages',
                () => _open(StoreScreen(_c)), highlight: true),
          ];
          return ListView.separated(
            padding: const EdgeInsets.all(12),
            itemCount: tiles.length,
            separatorBuilder: (_, __) => const SizedBox(height: 8),
            itemBuilder: (_, i) => tiles[i],
          );
        },
      ),
    );
  }
}

class _MenuTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  final bool highlight;
  const _MenuTile(this.icon, this.title, this.subtitle, this.onTap,
      {this.highlight = false});

  @override
  Widget build(BuildContext context) {
    return Card(
      color: highlight ? ccpAccent.withValues(alpha: 0.14) : ccpPanel,
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: ccpAccent.withValues(alpha: 0.18),
          child: Icon(icon, color: ccpAccent),
        ),
        title: Text(title,
            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
        subtitle: Text(subtitle, style: const TextStyle(color: ccpMuted)),
        trailing: const Icon(Icons.chevron_right),
        onTap: onTap,
      ),
    );
  }
}
