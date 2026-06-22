import 'package:flutter/foundation.dart';
import 'auth.dart';
import 'device_api.dart';
import 'hub_api.dart';

/// Holds the editable config for one display and persists it.
/// Shared across all the per-page settings screens.
class DeviceController extends ChangeNotifier {
  final DeviceApi api;
  final Map<String, dynamic> info;
  Map<String, dynamic> config = {};
  double brightness = 80;
  String? userEmail;
  bool loaded = false;
  List<String> entitlements = []; // slugs this CryptoClock holds
  List<Map<String, dynamic>> catalog = []; // store items (price/desc per slug)

  DeviceController(this.api, this.info) {
    brightness = (info['brightness'] as num? ?? 80).toDouble();
  }

  static const allPages = ['clock', 'crypto', 'slideshow'];
  static const maxAlerts = 8;
  /// The display shows pages one-at-a-time (lazy-swap on swipe); the rotation is
  /// capped so a long list can't exhaust the device's page array.
  static const maxPages = 5;

  static const _nativeTitles = {
    'clock': 'Clock',
    'crypto': 'Crypto',
    'slideshow': 'Photo slideshow',
  };

  String get deviceId => (info['device_id'] as String?) ?? 'device';

  Future<void> load() async {
    config = await api.getConfig();
    userEmail = await AuthService.savedEmail();
    // per-device rights + catalog from the Hub (best-effort)
    entitlements = await HubApi.deviceEntitlements(deviceId);
    catalog = await HubApi.catalog();
    loaded = true;
    notifyListeners();
  }

  /// Does THIS CryptoClock hold the given right?
  bool has(String slug) => entitlements.contains(slug);

  /// Catalog metadata (title/description/priceCents) for a slug.
  Map<String, dynamic>? catalogItem(String slug) {
    for (final c in catalog) {
      if (c['slug'] == slug || c['runtimeSlug'] == slug) return c;
    }
    return null;
  }

  // ---- typed slices ----
  Map<String, dynamic> section(String key) =>
      Map<String, dynamic>.from((config[key] as Map<String, dynamic>?) ?? {});

  List<String> get enabledPages =>
      ((config['pages'] as List?)?.cast<String>()) ?? List.of(allPages);

  /// Pages the user can put in the rotation: the 3 native pages + any PAGE-kind
  /// item this device is entitled to (weather, profile, …) + anything already
  /// enabled. Order: native first, then the rest.
  List<String> get availablePages {
    final pages = <String>[...allPages];
    for (final c in catalog) {
      final productSlug = c['slug'] as String?;
      final runtimeSlug = (c['runtimeSlug'] as String?) ?? productSlug;
      if (c['kind'] == 'PAGE' && productSlug != null && runtimeSlug != null &&
          entitlements.contains(productSlug) && !pages.contains(runtimeSlug)) {
        pages.add(runtimeSlug);
      }
    }
    for (final p in enabledPages) {
      if (!pages.contains(p)) pages.add(p);
    }
    return pages;
  }

  /// Human label for a page slug (native names, else the catalog title, else
  /// a capitalised slug).
  String pageTitle(String slug) {
    if (_nativeTitles.containsKey(slug)) return _nativeTitles[slug]!;
    final title = catalogItem(slug)?['title'] as String?;
    if (title != null && title.isNotEmpty) return title;
    return slug.isEmpty ? slug : slug[0].toUpperCase() + slug.substring(1);
  }

  bool get pagesFull => enabledPages.length >= maxPages;

  List<String> get symbols =>
      ((section('crypto')['symbols'] as List?)?.cast<String>()) ??
      ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'DOGEUSDT'];

  List<Map<String, dynamic>> get alerts =>
      ((section('crypto')['alerts'] as List?) ?? [])
          .map((a) => Map<String, dynamic>.from(a as Map))
          .toList();

  /// Alerts are active only when THIS device holds the crypto-alerts right.
  bool get alertsUnlocked => has('crypto-alerts');

  static const maxAlarms = 8;

  /// Clock alarms (settings.clock.alarms). Each: {time:"07:30", days:[1,2,3,4,5],
  /// enabled:true, label:"Wake up", sound:"beep"|<asset path>, snooze:5}.
  List<Map<String, dynamic>> get alarms =>
      ((section('clock')['alarms'] as List?) ?? [])
          .map((a) => Map<String, dynamic>.from(a as Map))
          .toList();

  /// The Alarm add-on is active only when THIS device holds the clock-alarm right.
  bool get alarmUnlocked => has('clock-alarm');

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

  /// Enable/disable a page. Returns false (no change) when trying to enable a
  /// page past the [maxPages] cap, so the UI can explain why.
  bool setPageEnabled(String page, bool on) {
    final pages = List<String>.from(enabledPages);
    if (on) {
      if (pages.contains(page)) return true;
      if (pages.length >= maxPages) return false; // rotation full
      pages.add(page);
    } else {
      if (pages.length <= 1) return true; // at least one page must stay
      pages.remove(page);
    }
    config['pages'] = pages;
    notifyListeners();
    return true;
  }

  /// Reorder the enabled pages — the list order is the on-device swipe order.
  void reorderPages(int oldIndex, int newIndex) {
    final pages = List<String>.from(enabledPages);
    if (oldIndex < 0 || oldIndex >= pages.length) return;
    if (newIndex > oldIndex) newIndex -= 1;
    newIndex = newIndex.clamp(0, pages.length - 1);
    pages.insert(newIndex, pages.removeAt(oldIndex));
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
    final hubError = await HubApi.saveDeviceSettings(deviceId, cfg);
    if (hubError != null && kDebugMode) {
      debugPrint('Hub settings sync skipped/failed for $deviceId: $hubError');
    }
    config = cfg;
    notifyListeners();
  }
}
