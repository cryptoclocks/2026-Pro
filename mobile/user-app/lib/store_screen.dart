import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import 'device_controller.dart';
import 'secrets.dart';
import 'ui_helpers.dart';
import 'main.dart' show ccpAccent, ccpMuted, ccpPanel;

const _icons = {
  'alarm': Icons.alarm,
  'candlestick_chart': Icons.candlestick_chart,
  'cloud': Icons.cloud,
  'newspaper': Icons.newspaper,
  'event': Icons.event,
  'person': Icons.person,
  'photo_library': Icons.photo_library,
  'schedule': Icons.schedule,
  'trending_up': Icons.trending_up,
  'speed': Icons.speed,
  'extension': Icons.extension,
};

/// Browse extra pages from the Hub and buy them with Stripe.
class StoreScreen extends StatefulWidget {
  final DeviceController c;
  const StoreScreen(this.c, {super.key});
  @override
  State<StoreScreen> createState() => _StoreScreenState();
}

class _StoreScreenState extends State<StoreScreen> {
  List<Map<String, dynamic>> _items = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final res = await http
          .get(Uri.parse('$hubBaseUrl/api/v1/store/items'))
          .timeout(const Duration(seconds: 10));
      final list = (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
      setState(() {
        _items = list;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = 'Cannot reach the store.\nCheck the Hub is running.\n($e)';
        _loading = false;
      });
    }
  }

  String _price(Map<String, dynamic> it) {
    final cents = (it['priceCents'] as num?)?.toInt() ?? 0;
    if (cents == 0) return 'Free';
    final major = (cents / 100).toStringAsFixed(2);
    final currency = ((it['currency'] as String?) ?? 'thb').toLowerCase();
    return currency == 'thb' ? '฿$major' : '\$$major';
  }

  Future<void> _buy(Map<String, dynamic> it) async {
    if (widget.c.userEmail == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Login first (Profile tab) to purchase.')));
      return;
    }
    try {
      final res = await http
          .post(Uri.parse('$hubBaseUrl/api/v1/store/checkout'),
              headers: {'Content-Type': 'application/json'},
              body: jsonEncode(
                  {'slug': it['slug'], 'deviceId': widget.c.deviceId}))
          .timeout(const Duration(seconds: 15));
      final json = jsonDecode(res.body) as Map<String, dynamic>;
      if (json['configured'] == false) {
        if (mounted) {
          showDialog(
            context: context,
            builder: (d) => AlertDialog(
              title: const Text('Coming soon'),
              content: const Text(
                  'Payments are not enabled on this Hub yet (Stripe keys not configured). The page catalog is live — checkout will work once Stripe is set up.'),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(d),
                    child: const Text('OK')),
              ],
            ),
          );
        }
        return;
      }
      final url = json['url'] as String?;
      if (url != null && await canLaunchUrl(Uri.parse(url))) {
        await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Checkout failed: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Store', style: TextStyle(color: ccpAccent))),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(_error!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: ccpMuted)),
                ))
              : ListView(
                  padding: const EdgeInsets.all(12),
                  children: [
                    const Padding(
                      padding: EdgeInsets.only(bottom: 8, left: 4),
                      child: Text('Add pages and feature add-ons to your display',
                          style: TextStyle(color: ccpMuted)),
                    ),
                    ..._items.map((it) => Card(
                          color: ccpPanel,
                          child: ListTile(
                            leading: CircleAvatar(
                              backgroundColor: ccpAccent.withValues(alpha: 0.18),
                              child: Icon(
                                  _icons[it['icon']] ?? Icons.extension,
                                  color: ccpAccent),
                            ),
                            title: Text(it['title'] as String? ?? '',
                                style: const TextStyle(
                                    fontWeight: FontWeight.bold)),
                            subtitle: Text(it['description'] as String? ?? '',
                                style: const TextStyle(color: ccpMuted)),
                            trailing: FilledButton(
                              onPressed: () => _buy(it),
                              child: Text(_price(it)),
                            ),
                          ),
                        )),
                    const SizedBox(height: 12),
                    settingCard('How it works', const [
                      Text(
                        '1. Buy a page or feature here (Stripe).\n'
                        '2. Admin reviews and grants it to your display.\n'
                        '3. Granted pages download over the air and feature\n'
                        '   add-ons unlock on that CryptoClock.',
                        style: TextStyle(color: ccpMuted),
                      ),
                    ]),
                  ],
                ),
    );
  }
}
