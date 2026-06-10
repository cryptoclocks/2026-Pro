import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'device_controller.dart';
import 'hub_api.dart';
import 'ui_helpers.dart';
import 'main.dart' show ccpAccent, ccpMuted;
import 'auth.dart';
import 'login_screen.dart';
import 'symbol_picker.dart';
import 'slideshow_manager.dart';

/// Locked-feature card: description + price + Request-approval / Buy (per-device).
Widget lockedFeature(BuildContext context, DeviceController c, String slug) {
  final item = c.catalogItem(slug);
  final cents = (item?['priceCents'] as num?)?.toInt() ?? 0;
  final price = cents == 0 ? 'Free' : '\$${(cents / 100).toStringAsFixed(2)}';
  return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
    Row(children: [
      const Icon(Icons.lock, size: 16, color: ccpMuted),
      const SizedBox(width: 6),
      Expanded(child: Text((item?['title'] as String?) ?? 'Locked feature',
          style: const TextStyle(fontWeight: FontWeight.bold))),
      Text(price, style: const TextStyle(color: ccpAccent, fontWeight: FontWeight.bold)),
    ]),
    const SizedBox(height: 4),
    Text((item?['description'] as String?) ??
        'This feature is locked on this CryptoClock.',
        style: const TextStyle(color: ccpMuted, fontSize: 12)),
    const SizedBox(height: 8),
    Row(children: [
      Expanded(
        child: OutlinedButton.icon(
          icon: const Icon(Icons.verified, size: 16),
          label: const Text('Request approval'),
          onPressed: () async {
            final err = await HubApi.requestFeature(
              deviceId: c.deviceId, page: 'crypto', feature: 'alerts', detail: {});
            if (!context.mounted) return;
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                content: Text(err == null
                    ? 'Sent to admin for approval'
                    : 'Failed: $err')));
          },
        ),
      ),
      const SizedBox(width: 8),
      Expanded(
        child: FilledButton.icon(
          icon: const Icon(Icons.lock_open, size: 16),
          label: Text('Unlock $price'),
          onPressed: () async {
            final res = await HubApi.checkout(slug, c.deviceId);
            if (!context.mounted) return;
            final url = res['url'] as String?;
            if (res['configured'] == false) {
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                  content: Text('Payments not enabled yet — ask admin to approve')));
            } else if (url != null) {
              await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
            } else {
              ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('Checkout failed: ${res['error'] ?? ''}')));
            }
          },
        ),
      ),
    ]),
  ]);
}

/* ===================== System ===================== */
class SystemSettings extends StatefulWidget {
  final DeviceController c;
  const SystemSettings(this.c, {super.key});
  @override
  State<SystemSettings> createState() => _SystemSettingsState();
}

class _SystemSettingsState extends State<SystemSettings> {
  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    final dynamicMode = c.config['display_mode'] == 'dynamic';
    return AnimatedBuilder(
      animation: c,
      builder: (context, _) => SettingsScaffold(
        title: 'System',
        onSave: c.save,
        children: [
          settingCard('Pages shown', [
            ...DeviceController.allPages.map((p) {
              final on = c.enabledPages.contains(p);
              final lastOne = on && c.enabledPages.length == 1;
              return CheckboxListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                title: Text({
                  'clock': 'Clock',
                  'crypto': 'Crypto',
                  'slideshow': 'Photo slideshow'
                }[p]!),
                value: on,
                activeColor: ccpAccent,
                onChanged: lastOne ? null : (v) => c.setPageEnabled(p, v ?? false),
              );
            }),
          ]),
          settingCard('Behaviour', [
            settingRow<String>('Display mode', dynamicMode ? 'dynamic' : 'static',
                const ['static', 'dynamic'],
                (v) => c.setTop('display_mode', v),
                fmt: (v) => v == 'static' ? 'static (swipe)' : 'dynamic (auto)'),
            if (dynamicMode)
              settingRow<int>('Page delay',
                  (c.config['page_delay_s'] as num? ?? 10).toInt(),
                  const [5, 10, 15, 30, 60],
                  (v) => c.setTop('page_delay_s', v),
                  fmt: (v) => '${v}s'),
            const SizedBox(height: 8),
            Text('Brightness: ${c.brightness.round()}%',
                style: const TextStyle(color: ccpMuted)),
            Slider(
              value: c.brightness,
              min: 5,
              max: 100,
              activeColor: ccpAccent,
              onChanged: (v) => setState(() => c.brightness = v),
              onChangeEnd: c.setBrightness,
            ),
          ]),
          settingCard('Maintenance', [
            OutlinedButton.icon(
              icon: const Icon(Icons.notifications_active),
              label: const Text('Identify (beep + flash)'),
              onPressed: () => c.api.identify(),
            ),
            const SizedBox(height: 6),
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(foregroundColor: Colors.redAccent),
              icon: const Icon(Icons.wifi_off),
              label: const Text('Reset WiFi'),
              onPressed: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (d) => AlertDialog(
                    title: const Text('Reset WiFi?'),
                    content: const Text(
                        'The display reboots into its setup portal (CCP-Setup-XXXX).'),
                    actions: [
                      TextButton(
                          onPressed: () => Navigator.pop(d, false),
                          child: const Text('Cancel')),
                      TextButton(
                          onPressed: () => Navigator.pop(d, true),
                          child: const Text('Reset')),
                    ],
                  ),
                );
                if (ok == true) await c.api.wifiReset();
              },
            ),
          ]),
        ],
      ),
    );
  }
}

/* ===================== Profile ===================== */
class ProfileSettings extends StatefulWidget {
  final DeviceController c;
  const ProfileSettings(this.c, {super.key});
  @override
  State<ProfileSettings> createState() => _ProfileSettingsState();
}

class _ProfileSettingsState extends State<ProfileSettings> {
  late final TextEditingController _name = TextEditingController(
      text: (widget.c.section('profile')['name'] as String?) ?? '');

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    return AnimatedBuilder(
      animation: c,
      builder: (context, _) => SettingsScaffold(
        title: 'Profile',
        onSave: () async {
          c.patch('profile', 'name', _name.text.trim());
          await c.save();
        },
        children: [
          settingCard('Display owner', [
            TextField(
              controller: _name,
              decoration: const InputDecoration(
                  labelText: 'Profile name (shown on clock)',
                  border: OutlineInputBorder(),
                  isDense: true),
            ),
          ]),
          settingCard('Account', [
            if (c.userEmail == null) ...[
              const Text('Login unlocks price alerts and the Store.',
                  style: TextStyle(color: ccpMuted)),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                icon: const Icon(Icons.login),
                label: const Text('Login'),
                onPressed: () async {
                  final email = await Navigator.push<String>(context,
                      MaterialPageRoute(builder: (_) => const LoginScreen()));
                  if (email != null) c.setLogin(email);
                },
              ),
            ] else ...[
              Row(children: [
                const Icon(Icons.verified_user, color: ccpAccent, size: 18),
                const SizedBox(width: 8),
                Expanded(
                    child: Text(c.userEmail!,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: ccpMuted))),
                TextButton(
                  onPressed: () async {
                    await AuthService.signOut();
                    c.setLogin(null);
                  },
                  child: const Text('Logout'),
                ),
              ]),
            ],
          ]),
        ],
      ),
    );
  }
}

/* ===================== Clock ===================== */
class ClockSettings extends StatelessWidget {
  final DeviceController c;
  const ClockSettings(this.c, {super.key});
  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: c,
      builder: (context, _) => SettingsScaffold(
        title: 'Clock',
        onSave: c.save,
        children: [
          settingCard('Appearance', [
            settingRow<String>('Theme',
                (c.section('clock')['theme'] as String?) ?? 'gold',
                const ['gold', 'mint', 'neon'],
                (v) => c.patch('clock', 'theme', v)),
          ]),
        ],
      ),
    );
  }
}

/* ===================== Crypto ===================== */
class CryptoSettings extends StatelessWidget {
  final DeviceController c;
  const CryptoSettings(this.c, {super.key});

  Future<void> _addAlert(BuildContext context) async {
    String symbol = c.symbols.first;
    String dir = 'above';
    final priceCtl = TextEditingController();
    final added = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (d) => StatefulBuilder(
        builder: (d, setD) => AlertDialog(
          title: const Text('New price alert'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            DropdownButtonFormField<String>(
              initialValue: symbol,
              decoration: const InputDecoration(labelText: 'Coin', isDense: true),
              items: c.symbols
                  .map((s) => DropdownMenuItem(
                      value: s, child: Text(s.replaceAll('USDT', ''))))
                  .toList(),
              onChanged: (v) => setD(() => symbol = v ?? symbol),
            ),
            DropdownButtonFormField<String>(
              initialValue: dir,
              decoration:
                  const InputDecoration(labelText: 'Condition', isDense: true),
              items: const [
                DropdownMenuItem(value: 'above', child: Text('Price ABOVE')),
                DropdownMenuItem(value: 'below', child: Text('Price BELOW')),
              ],
              onChanged: (v) => setD(() => dir = v ?? dir),
            ),
            TextField(
              controller: priceCtl,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              decoration:
                  const InputDecoration(labelText: 'Price (USDT)', isDense: true),
            ),
          ]),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(d), child: const Text('Cancel')),
            FilledButton(
              onPressed: () {
                final p = double.tryParse(priceCtl.text.trim());
                if (p == null || p <= 0) return;
                Navigator.pop(d, {'symbol': symbol, 'dir': dir, 'price': p});
              },
              child: const Text('Add'),
            ),
          ],
        ),
      ),
    );
    if (added != null) c.patch('crypto', 'alerts', [...c.alerts, added]);
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: c,
      builder: (context, _) {
        final crypto = c.section('crypto');
        return SettingsScaffold(
          title: 'Crypto',
          onSave: c.save,
          children: [
            settingCard('Coins (max 4)', [
              Wrap(spacing: 6, children: [
                ...c.symbols.map((sym) => Chip(
                      label: Text(sym.replaceAll('USDT', '')),
                      onDeleted: c.symbols.length > 1
                          ? () => c.patch('crypto', 'symbols',
                              c.symbols.where((x) => x != sym).toList())
                          : null,
                    )),
                if (c.symbols.length < 4)
                  ActionChip(
                    avatar: const Icon(Icons.add, size: 16),
                    label: const Text('Add coin'),
                    onPressed: () async {
                      final sym = await showSymbolPicker(context);
                      if (sym != null && !c.symbols.contains(sym)) {
                        c.patch('crypto', 'symbols', [...c.symbols, sym]);
                      }
                    },
                  ),
              ]),
            ]),
            settingCard('Chart & price', [
              settingRow<String>('Style', (crypto['style'] as String?) ?? 'chart',
                  const ['chart', 'big'], (v) => c.patch('crypto', 'style', v),
                  fmt: (v) => v == 'chart' ? 'price + graph' : 'big price'),
              settingRow<String>('Default timeframe',
                  (crypto['timeframe'] as String?) ?? '15m',
                  const ['15m', '1h', '4h', '1d'],
                  (v) => c.patch('crypto', 'timeframe', v)),
              settingRow<String>('Currency',
                  (crypto['currency'] as String?) ?? 'USD',
                  const ['USD', 'THB'], (v) => c.patch('crypto', 'currency', v)),
              settingRow<int>('Fetch every',
                  (crypto['fetch_interval_s'] as num? ?? 10).toInt(),
                  const [5, 10, 30, 60, 300, 900],
                  (v) => c.patch('crypto', 'fetch_interval_s', v),
                  fmt: (v) => v < 60 ? '${v}s' : '${v ~/ 60}m'),
            ]),
            settingCard('Price alerts (${c.alerts.length}/${DeviceController.maxAlerts})', [
              if (c.userEmail == null) ...[
                const Text('Login (Profile tab) to manage alerts.',
                    style: TextStyle(color: ccpMuted)),
              ] else if (!c.alertsUnlocked) ...[
                lockedFeature(context, c, 'crypto-alerts'),
              ] else ...[
                ...c.alerts.asMap().entries.map((e) {
                  final a = e.value;
                  final above = a['dir'] != 'below';
                  return ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(above ? Icons.trending_up : Icons.trending_down,
                        color: above ? Colors.greenAccent : Colors.redAccent),
                    title: Text(
                        '${(a['symbol'] as String? ?? '').replaceAll('USDT', '')} '
                        '${above ? '>' : '<'} ${a['price']}'),
                    trailing: IconButton(
                      icon: const Icon(Icons.delete_outline,
                          color: Colors.redAccent, size: 20),
                      onPressed: () =>
                          c.patch('crypto', 'alerts', c.alerts..removeAt(e.key)),
                    ),
                  );
                }),
                Row(children: [
                  const Icon(Icons.verified_user, size: 14, color: ccpAccent),
                  const SizedBox(width: 4),
                  const Expanded(child: Text('Unlocked on this CryptoClock',
                      style: TextStyle(color: ccpAccent, fontSize: 12))),
                ]),
                if (c.alerts.length < DeviceController.maxAlerts)
                  OutlinedButton.icon(
                    icon: const Icon(Icons.add_alert),
                    label: const Text('Add alert'),
                    onPressed: () => _addAlert(context),
                  ),
                const Text(
                    'Tap "Save to display" to apply. On the display: Snooze (5 min) '
                    'or Stop (off).',
                    style: TextStyle(color: ccpMuted, fontSize: 12)),
              ],
            ]),
          ],
        );
      },
    );
  }
}

/* ===================== Photos ===================== */
class PhotosSettings extends StatelessWidget {
  final DeviceController c;
  const PhotosSettings(this.c, {super.key});
  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: c,
      builder: (context, _) {
        final slide = c.section('slideshow');
        return SettingsScaffold(
          title: 'Photo slideshow',
          onSave: c.save,
          children: [
            settingCard('Playback', [
              settingRow<String>('Effect', (slide['effect'] as String?) ?? 'fade',
                  const ['fade', 'slide', 'none'],
                  (v) => c.patch('slideshow', 'effect', v)),
              settingRow<int>('Interval',
                  (slide['interval_s'] as num? ?? 5).toInt(),
                  const [3, 5, 10, 15, 30],
                  (v) => c.patch('slideshow', 'interval_s', v),
                  fmt: (v) => '${v}s'),
            ]),
            settingCard('Photos', [
              const Text('Photos display best at 480×320 (landscape).',
                  style: TextStyle(color: ccpMuted, fontSize: 12)),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                icon: const Icon(Icons.photo_library),
                label: const Text('Manage photos (upload / reorder)'),
                onPressed: () async {
                  final order = await Navigator.push<List<String>>(
                    context,
                    MaterialPageRoute(
                        builder: (_) => SlideshowManager(api: c.api)),
                  );
                  if (order != null) c.patch('slideshow', 'order', order);
                },
              ),
            ]),
          ],
        );
      },
    );
  }
}
