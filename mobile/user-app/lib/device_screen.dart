import 'package:flutter/material.dart';
import 'device_api.dart';
import 'main.dart' show ccpAccent, ccpMuted, ccpPanel;
import 'symbol_picker.dart';
import 'slideshow_manager.dart';

/// Full settings for one display: pages, mode, clock theme, coins, slideshow.
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

  static const _allPages = ['clock', 'crypto', 'slideshow'];
  static const _themes = ['gold', 'mint', 'neon'];
  static const _effects = ['fade', 'slide', 'none'];
  static const _fetchIntervals = [5, 10, 30, 60, 300, 900];
  static const _pageDelays = [5, 10, 15, 30, 60];

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
    });
  }

  Map<String, dynamic> get _crypto =>
      (_config['crypto'] as Map<String, dynamic>?) ?? {};
  Map<String, dynamic> get _slideshow =>
      (_config['slideshow'] as Map<String, dynamic>?) ?? {};

  List<String> get _enabledPages =>
      ((_config['pages'] as List?)?.cast<String>()) ?? List.of(_allPages);
  List<String> get _symbols =>
      ((_crypto['symbols'] as List?)?.cast<String>()) ??
      ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'DOGEUSDT'];

  void _patch(String section, String key, dynamic value) {
    setState(() {
      final sec = Map<String, dynamic>.from(
          (_config[section] as Map<String, dynamic>?) ?? {});
      sec[key] = value;
      _config[section] = sec;
    });
  }

  Future<void> _save() async {
    setState(() => _busy = true);
    final cfg = {
      ..._config,
      'pages': _enabledPages,
      'brightness': _brightness.round(),
      'profile': {
        ...?(_config['profile'] as Map<String, dynamic>?),
        if (_nameCtl.text.trim().isNotEmpty) 'name': _nameCtl.text.trim(),
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

  Widget _section(String title, List<Widget> children) {
    return Card(
      color: ccpPanel,
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title,
              style: const TextStyle(
                  color: ccpAccent, fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          ...children,
        ]),
      ),
    );
  }

  Widget _dropdown<T>(String label, T value, List<T> options,
      ValueChanged<T> onChanged, {String Function(T)? fmt}) {
    return Row(children: [
      Expanded(child: Text(label, style: const TextStyle(color: ccpMuted))),
      DropdownButton<T>(
        value: options.contains(value) ? value : options.first,
        items: options
            .map((o) => DropdownMenuItem(value: o, child: Text(fmt?.call(o) ?? '$o')))
            .toList(),
        onChanged: (v) => v != null ? onChanged(v) : null,
      ),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final id = widget.info['device_id'] ?? 'device';
    final dynamicMode = _config['display_mode'] == 'dynamic';

    return Scaffold(
      appBar: AppBar(
        title: Text(id, style: const TextStyle(color: ccpAccent)),
        actions: [
          IconButton(
              onPressed: () => widget.api.identify(),
              icon: const Icon(Icons.notifications_active),
              tooltip: 'Identify (beep)'),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          _section('Pages', [
            ..._allPages.map((p) {
              final pages = _enabledPages;
              final enabled = pages.contains(p);
              // at least one page must stay enabled
              final lastOne = enabled && pages.length == 1;
              return CheckboxListTile(
                dense: true,
                title: Text(p),
                value: enabled,
                activeColor: ccpAccent,
                onChanged: lastOne
                    ? null
                    : (v) {
                        setState(() {
                          if (v == true && !enabled) pages.add(p);
                          if (v == false && enabled) pages.remove(p);
                          _config['pages'] = pages;
                        });
                      },
              );
            }),
            _dropdown<String>(
                'Display mode',
                dynamicMode ? 'dynamic' : 'static',
                const ['static', 'dynamic'],
                (v) => setState(() => _config['display_mode'] = v),
                fmt: (v) => v == 'static' ? 'static (swipe)' : 'dynamic (auto)'),
            if (dynamicMode)
              _dropdown<int>(
                  'Page delay',
                  (_config['page_delay_s'] as num? ?? 10).toInt(),
                  _pageDelays,
                  (v) => setState(() => _config['page_delay_s'] = v),
                  fmt: (v) => '${v}s'),
          ]),
          _section('Clock', [
            TextField(
              controller: _nameCtl,
              decoration: const InputDecoration(
                  labelText: 'Profile name', border: OutlineInputBorder(), isDense: true),
            ),
            const SizedBox(height: 8),
            _dropdown<String>(
                'Theme',
                (_config['clock']?['theme'] as String?) ?? 'gold',
                _themes,
                (v) => _patch('clock', 'theme', v)),
          ]),
          _section('Crypto', [
            Wrap(
              spacing: 6,
              children: [
                ..._symbols.map((sym) => Chip(
                      label: Text(sym.replaceAll('USDT', '')),
                      onDeleted: _symbols.length > 1
                          ? () => _patch('crypto', 'symbols',
                              _symbols.where((x) => x != sym).toList())
                          : null,
                    )),
                if (_symbols.length < 4)
                  ActionChip(
                    avatar: const Icon(Icons.add, size: 16),
                    label: const Text('Add coin'),
                    onPressed: () async {
                      final sym = await showSymbolPicker(context);
                      if (sym != null && !_symbols.contains(sym)) {
                        _patch('crypto', 'symbols', [..._symbols, sym]);
                      }
                    },
                  ),
              ],
            ),
            _dropdown<String>(
                'Style',
                (_crypto['style'] as String?) ?? 'chart',
                const ['chart', 'big'],
                (v) => _patch('crypto', 'style', v),
                fmt: (v) => v == 'chart' ? 'price + graph' : 'big price only'),
            _dropdown<String>(
                'Currency',
                (_crypto['currency'] as String?) ?? 'USD',
                const ['USD', 'THB'],
                (v) => _patch('crypto', 'currency', v)),
            _dropdown<int>(
                'Fetch every',
                (_crypto['fetch_interval_s'] as num? ?? 10).toInt(),
                _fetchIntervals,
                (v) => _patch('crypto', 'fetch_interval_s', v),
                fmt: (v) => v < 60 ? '${v}s' : '${v ~/ 60}m'),
          ]),
          _section('Slideshow', [
            _dropdown<String>(
                'Effect',
                (_slideshow['effect'] as String?) ?? 'fade',
                _effects,
                (v) => _patch('slideshow', 'effect', v)),
            _dropdown<int>(
                'Interval',
                (_slideshow['interval_s'] as num? ?? 5).toInt(),
                const [3, 5, 10, 15, 30],
                (v) => _patch('slideshow', 'interval_s', v),
                fmt: (v) => '${v}s'),
            const SizedBox(height: 4),
            OutlinedButton.icon(
              onPressed: () async {
                final order = await Navigator.push<List<String>>(
                  context,
                  MaterialPageRoute(
                      builder: (_) => SlideshowManager(api: widget.api)),
                );
                if (order != null) {
                  _patch('slideshow', 'order', order);
                }
              },
              icon: const Icon(Icons.photo_library),
              label: const Text('Manage photos (upload / reorder)'),
            ),
          ]),
          _section('Display', [
            Text('Brightness: ${_brightness.round()}%',
                style: const TextStyle(color: ccpMuted)),
            Slider(
              value: _brightness,
              min: 5,
              max: 100,
              activeColor: ccpAccent,
              onChanged: (v) => setState(() => _brightness = v),
              onChangeEnd: (v) => widget.api.setBrightness(v.round()),
            ),
          ]),
          FilledButton(
            onPressed: _busy ? null : _save,
            child: Text(_busy ? 'Saving...' : 'Save to display'),
          ),
          const SizedBox(height: 12),
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
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}
