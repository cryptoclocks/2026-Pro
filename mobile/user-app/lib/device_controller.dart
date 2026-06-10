import 'package:flutter/foundation.dart';
import 'auth.dart';
import 'device_api.dart';

/// Holds the editable config for one display and persists it.
/// Shared across all the per-page settings screens.
class DeviceController extends ChangeNotifier {
  final DeviceApi api;
  final Map<String, dynamic> info;
  Map<String, dynamic> config = {};
  double brightness = 80;
  String? userEmail;
  bool loaded = false;

  DeviceController(this.api, this.info) {
    brightness = (info['brightness'] as num? ?? 80).toDouble();
  }

  static const allPages = ['clock', 'crypto', 'slideshow'];
  static const maxAlerts = 8;

  String get deviceId => (info['device_id'] as String?) ?? 'device';

  Future<void> load() async {
    config = await api.getConfig();
    userEmail = await AuthService.savedEmail();
    loaded = true;
    notifyListeners();
  }

  // ---- typed slices ----
  Map<String, dynamic> section(String key) =>
      Map<String, dynamic>.from((config[key] as Map<String, dynamic>?) ?? {});

  List<String> get enabledPages =>
      ((config['pages'] as List?)?.cast<String>()) ?? List.of(allPages);

  List<String> get symbols =>
      ((section('crypto')['symbols'] as List?)?.cast<String>()) ??
      ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'DOGEUSDT'];

  List<Map<String, dynamic>> get alerts =>
      ((section('crypto')['alerts'] as List?) ?? [])
          .map((a) => Map<String, dynamic>.from(a as Map))
          .toList();

  bool get alertsUnlocked => userEmail != null;

  // ---- mutations ----
  void setTop(String key, dynamic value) {
    config[key] = value;
    notifyListeners();
  }

  void patch(String sectionKey, String key, dynamic value) {
    final sec = section(sectionKey);
    sec[key] = value;
    config[sectionKey] = sec;
    notifyListeners();
  }

  void setPageEnabled(String page, bool on) {
    final pages = enabledPages;
    if (on && !pages.contains(page)) pages.add(page);
    if (!on && pages.contains(page)) pages.remove(page);
    if (pages.isEmpty) return; // at least one page must stay
    config['pages'] = pages;
    notifyListeners();
  }

  Future<void> setBrightness(double v) async {
    brightness = v;
    notifyListeners();
    await api.setBrightness(v.round());
  }

  Future<void> setLogin(String? email) async {
    userEmail = email;
    notifyListeners();
  }

  /// Push the whole config to the display (which reloads its pages).
  Future<void> save() async {
    final cfg = {
      ...config,
      'pages': enabledPages,
      'brightness': brightness.round(),
      if (userEmail != null) 'owner': {'email': userEmail},
    };
    await api.setConfig(cfg);
    config = cfg;
    notifyListeners();
  }
}
