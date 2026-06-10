import 'package:flutter/material.dart';
import 'device_api.dart';
import 'main.dart' show ccpAccent, ccpMuted, ccpPanel;

/// Settings page for one display: pages, symbol, profile, brightness.
class DeviceScreen extends StatefulWidget {
  final DeviceApi api;
  final Map<String, dynamic> info;
  const DeviceScreen({super.key, required this.api, required this.info});

  @override
  State<DeviceScreen> createState() => _DeviceScreenState();
}

class _DeviceScreenState extends State<DeviceScreen> {
  Map<String, dynamic> _config = {};
  double _brightness = 80;
  bool _busy = false;
  final _nameCtl = TextEditingController();
  final _symbolCtl = TextEditingController();

  static const _allPages = ['clock', 'crypto', 'slideshow'];

  @override
  void initState() {
    super.initState();
    _brightness = (widget.info['brightness'] as num? ?? 80).toDouble();
    _load();
  }

  Future<void> _load() async {
    final cfg = await widget.api.getConfig();
    setState(() {
      _config = cfg;
      _nameCtl.text = (cfg['profile']?['name'] as String?) ?? '';
      _symbolCtl.text = (cfg['crypto']?['symbol'] as String?) ?? 'BTCUSDT';
    });
  }

  List<String> get _enabledPages =>
      ((_config['pages'] as List?)?.cast<String>()) ?? List.of(_allPages);

  Future<void> _save() async {
    setState(() => _busy = true);
    final symbol = _symbolCtl.text.trim().toUpperCase();
    final cfg = {
      ..._config,
      'pages': _enabledPages,
      'brightness': _brightness.round(),
      'profile': {
        ...?(_config['profile'] as Map<String, dynamic>?),
        if (_nameCtl.text.trim().isNotEmpty) 'name': _nameCtl.text.trim(),
      },
      'crypto': {
        ...?(_config['crypto'] as Map<String, dynamic>?),
        'symbol': symbol,
        'display':
            '${symbol.replaceAll('USDT', '')}/USDT',
      },
    };
    try {
      await widget.api.setConfig(cfg);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Saved — display reloading')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Save failed: $e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final id = widget.info['device_id'] ?? 'device';
    return Scaffold(
      appBar: AppBar(title: Text(id, style: const TextStyle(color: ccpAccent))),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            color: ccpPanel,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('fw ${widget.info['fw']} · ${widget.info['ip']}'
                    ' · rssi ${widget.info['rssi']}dBm',
                    style: const TextStyle(color: ccpMuted)),
                Text(
                    'SD: ${widget.info['sd_mounted'] == true ? "mounted" : "not found"}'
                    ' · ${widget.info['claimed'] == true ? "claimed" : "unclaimed"}',
                    style: const TextStyle(color: ccpMuted)),
              ]),
            ),
          ),
          const SizedBox(height: 16),
          const Text('Pages (swipe order)'),
          ..._allPages.map((p) => CheckboxListTile(
                title: Text(p),
                value: _enabledPages.contains(p),
                activeColor: ccpAccent,
                onChanged: (v) {
                  final pages = _enabledPages;
                  setState(() {
                    if (v == true && !pages.contains(p)) {
                      pages.add(p);
                    } else if (v == false && pages.length > 1) {
                      pages.remove(p);
                    }
                    _config['pages'] = pages;
                  });
                },
              )),
          const SizedBox(height: 8),
          TextField(
            controller: _nameCtl,
            decoration: const InputDecoration(
                labelText: 'Profile name (clock page)', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _symbolCtl,
            decoration: const InputDecoration(
                labelText: 'Crypto symbol (e.g. BTCUSDT, ETHUSDT)',
                border: OutlineInputBorder()),
          ),
          const SizedBox(height: 12),
          Text('Brightness: ${_brightness.round()}%'),
          Slider(
            value: _brightness,
            min: 5,
            max: 100,
            activeColor: ccpAccent,
            onChanged: (v) => setState(() => _brightness = v),
            onChangeEnd: (v) => widget.api.setBrightness(v.round()),
          ),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: _busy ? null : _save,
            child: Text(_busy ? 'Saving...' : 'Save to display'),
          ),
          const SizedBox(height: 24),
          OutlinedButton.icon(
            onPressed: () => widget.api.identify(),
            icon: const Icon(Icons.notifications_active),
            label: const Text('Identify (beep)'),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            style: OutlinedButton.styleFrom(foregroundColor: Colors.redAccent),
            onPressed: () async {
              final ok = await showDialog<bool>(
                context: context,
                builder: (c) => AlertDialog(
                  title: const Text('Reset WiFi?'),
                  content: const Text(
                      'The display reboots into its setup portal (CCP-Setup-XXXX).'),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
                    TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Reset')),
                  ],
                ),
              );
              if (ok == true) await widget.api.wifiReset();
            },
            icon: const Icon(Icons.wifi_off),
            label: const Text('Reset WiFi'),
          ),
        ],
      ),
    );
  }
}
