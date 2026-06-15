import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:image/image.dart' as img;
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';
import 'device_controller.dart';
import 'hub_api.dart';
import 'ui_helpers.dart';
import 'main.dart' show ccpAccent, ccpMuted, ccpPanel, AuthGate;
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
          settingCard(
              'Pages shown  (${c.enabledPages.length}/${DeviceController.maxPages})', [
            const Padding(
              padding: EdgeInsets.only(bottom: 6),
              child: Text('Drag to set the swipe order. Up to 5 pages — the '
                  'display shows one at a time.',
                  style: TextStyle(color: ccpMuted, fontSize: 12)),
            ),
            // enabled pages — reorderable; list order == on-device swipe order
            ReorderableListView(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              buildDefaultDragHandles: false,
              onReorder: (o, n) => setState(() => c.reorderPages(o, n)),
              children: [
                for (final e in c.enabledPages.asMap().entries)
                  ListTile(
                    key: ValueKey('pg_${e.value}'),
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: ReorderableDragStartListener(
                      index: e.key,
                      child: const Icon(Icons.drag_handle, color: ccpMuted),
                    ),
                    title: Text(c.pageTitle(e.value)),
                    trailing: c.enabledPages.length > 1
                        ? IconButton(
                            icon: const Icon(Icons.remove_circle_outline,
                                color: ccpMuted),
                            onPressed: () =>
                                setState(() => c.setPageEnabled(e.value, false)),
                          )
                        : null,
                  ),
              ],
            ),
            // entitled pages not yet enabled — tap to add (blocked when full)
            ...c.availablePages
                .where((p) => !c.enabledPages.contains(p))
                .map((p) {
              final full = c.pagesFull;
              return ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                enabled: !full,
                leading: Icon(Icons.add_circle_outline,
                    color: full ? ccpMuted.withValues(alpha: 0.4) : ccpAccent),
                title: Text(c.pageTitle(p),
                    style: TextStyle(color: full ? ccpMuted : null)),
                onTap: full
                    ? null
                    : () {
                        if (!c.setPageEnabled(p, true)) {
                          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                              content: Text('Rotation full (5) — remove a page first')));
                        }
                      },
              );
            }),
            if (c.pagesFull)
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text('Rotation full (5). Remove a page to add another.',
                    style: TextStyle(color: ccpMuted, fontSize: 11)),
              ),
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
  static const _avatarPath = 'pages/profile/assets/avatar.png';
  late final _p = widget.c.section('profile');
  late final TextEditingController _name =
      TextEditingController(text: (_p['name'] as String?) ?? '');
  late final TextEditingController _nickname =
      TextEditingController(text: (_p['nickname'] as String?) ?? '');
  late final TextEditingController _role =
      TextEditingController(text: (_p['role'] as String?) ?? '');
  late final TextEditingController _motto = TextEditingController(
      text: (_p['motto'] as String?) ?? "DON'T TRUST  VERIFY");
  late final TextEditingController _company =
      TextEditingController(text: (_p['company'] as String?) ?? '');
  late bool _show = (_p['show'] as bool?) ?? true;
  // colour of each part (hex), bound to settings.profile.*_color on the device
  late final TextEditingController _nameColor =
      TextEditingController(text: (_p['name_color'] as String?) ?? '#EAECEF');
  late final TextEditingController _roleColor =
      TextEditingController(text: (_p['role_color'] as String?) ?? '#848E9C');
  late final TextEditingController _companyColor =
      TextEditingController(text: (_p['company_color'] as String?) ?? '#F0B90B');
  late final TextEditingController _verifyColor =
      TextEditingController(text: (_p['verify_color'] as String?) ?? '#F0B90B');
  late final TextEditingController _bgColor =
      TextEditingController(text: (_p['bg_color'] as String?) ?? '#0B0E11');
  // social links shown as QR codes on the profile page's social popups
  late final TextEditingController _fbUrl =
      TextEditingController(text: (_p['fb_url'] as String?) ?? '');
  late final TextEditingController _ytUrl =
      TextEditingController(text: (_p['yt_url'] as String?) ?? '');
  late final TextEditingController _ttUrl =
      TextEditingController(text: (_p['tt_url'] as String?) ?? '');
  late final TextEditingController _igUrl =
      TextEditingController(text: (_p['ig_url'] as String?) ?? '');
  late String _fbFollowers = (_p['fb_followers'] as String?) ?? '';
  late String _fbFollowing = (_p['fb_following'] as String?) ?? '';
  late String _fbSecondaryLabel =
      (_p['fb_secondary_label'] as String?) ?? 'Following';
  late String _ytFollowers = (_p['yt_followers'] as String?) ?? '';
  late String _ytFollowing = (_p['yt_following'] as String?) ?? '';
  late String _ytSecondaryLabel =
      (_p['yt_secondary_label'] as String?) ?? 'Following';
  late String _ttFollowers = (_p['tt_followers'] as String?) ?? '';
  late String _ttFollowing = (_p['tt_following'] as String?) ?? '';
  late String _ttSecondaryLabel =
      (_p['tt_secondary_label'] as String?) ?? 'Following';
  late String _igFollowers = (_p['ig_followers'] as String?) ?? '';
  late String _igFollowing = (_p['ig_following'] as String?) ?? '';
  late String _igSecondaryLabel =
      (_p['ig_secondary_label'] as String?) ?? 'Following';
  late String _avatar = (_p['avatar'] as String?) ?? '';
  bool _avatarBusy = false;
  bool _socialBusy = false;

  void _patchProfileConfig(DeviceController c) {
    c.patch('profile', 'name', _name.text.trim());
    // Builder Profile page (settings.profile.*) — what the on-device
    // package page binds to.
    c.patch('profile', 'nickname', _nickname.text.trim());
    c.patch('profile', 'role', _role.text.trim());
    c.patch('profile', 'motto', _motto.text.trim());
    c.patch('profile', 'company', _company.text.trim());
    c.patch('profile', 'show', _show);
    c.patch('profile', 'name_color', _nameColor.text.trim());
    c.patch('profile', 'role_color', _roleColor.text.trim());
    c.patch('profile', 'company_color', _companyColor.text.trim());
    c.patch('profile', 'verify_color', _verifyColor.text.trim());
    c.patch('profile', 'bg_color', _bgColor.text.trim());
    c.patch('profile', 'fb_url', _fbUrl.text.trim());
    c.patch('profile', 'yt_url', _ytUrl.text.trim());
    c.patch('profile', 'tt_url', _ttUrl.text.trim());
    c.patch('profile', 'ig_url', _igUrl.text.trim());
    c.patch('profile', 'fb_followers', _fbFollowers);
    c.patch('profile', 'fb_following', _fbFollowing);
    c.patch('profile', 'fb_secondary_label', _fbSecondaryLabel);
    c.patch('profile', 'yt_followers', _ytFollowers);
    c.patch('profile', 'yt_following', _ytFollowing);
    c.patch('profile', 'yt_secondary_label', _ytSecondaryLabel);
    c.patch('profile', 'tt_followers', _ttFollowers);
    c.patch('profile', 'tt_following', _ttFollowing);
    c.patch('profile', 'tt_secondary_label', _ttSecondaryLabel);
    c.patch('profile', 'ig_followers', _igFollowers);
    c.patch('profile', 'ig_following', _igFollowing);
    c.patch('profile', 'ig_secondary_label', _igSecondaryLabel);
    c.patch('profile', 'avatar', _avatar);
  }

  void _setSocialStats(String key, Map<String, dynamic> data) {
    final followers = (data['followers'] ?? data['likes'] ?? '').toString();
    final following =
        (data['secondaryValue'] ?? data['following'] ?? data['talkingAbout'] ?? '')
            .toString();
    final label = (data['secondaryLabel'] ?? 'Following').toString();
    setState(() {
      switch (key) {
        case 'fb':
          if (followers.isNotEmpty) _fbFollowers = followers;
          if (following.isNotEmpty) _fbFollowing = following;
          _fbSecondaryLabel = label;
          break;
        case 'yt':
          if (followers.isNotEmpty) _ytFollowers = followers;
          if (following.isNotEmpty) _ytFollowing = following;
          _ytSecondaryLabel = label;
          break;
        case 'tt':
          if (followers.isNotEmpty) _ttFollowers = followers;
          if (following.isNotEmpty) _ttFollowing = following;
          _ttSecondaryLabel = label;
          break;
        case 'ig':
          if (followers.isNotEmpty) _igFollowers = followers;
          if (following.isNotEmpty) _igFollowing = following;
          _igSecondaryLabel = label;
          break;
      }
    });
  }

  Future<void> _refreshSocialStats() async {
    final entries = [
      ['fb', 'facebook', _fbUrl.text.trim()],
      ['yt', 'youtube', _ytUrl.text.trim()],
      ['tt', 'tiktok', _ttUrl.text.trim()],
      ['ig', 'instagram', _igUrl.text.trim()],
    ].where((e) => e[2].isNotEmpty).toList();
    if (entries.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Add at least one social URL first')),
      );
      return;
    }
    setState(() => _socialBusy = true);
    try {
      final notes = <String>[];
      for (final e in entries) {
        final data = await HubApi.resolveSocial(e[2], e[1]);
        if (data['error'] != null) throw Exception('${e[0]}: ${data['error']}');
        _setSocialStats(e[0], data);
        final followers = (data['followers'] ?? data['likes'] ?? '?').toString();
        final second =
            (data['secondaryValue'] ?? data['following'] ?? data['talkingAbout'] ?? '?')
                .toString();
        notes.add('${e[0].toUpperCase()} $followers / $second');
      }
      _patchProfileConfig(widget.c);
      await widget.c.save();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Social stats updated: ${notes.join(', ')}')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Social refresh failed: $e')));
      }
    } finally {
      if (mounted) setState(() => _socialBusy = false);
    }
  }

  Widget _socialStatLine(
      String label, String followers, String following, String secondaryLabel) {
    return Text('$label: ${followers.isEmpty ? '—' : followers} / '
        '${following.isEmpty ? '—' : following} $secondaryLabel',
        style: const TextStyle(color: ccpMuted, fontSize: 12));
  }

  Future<void> _uploadAvatar() async {
    final picked = await ImagePicker().pickImage(source: ImageSource.gallery);
    if (picked == null) return;
    setState(() => _avatarBusy = true);
    try {
      final raw = await File(picked.path).readAsBytes();
      final decoded = img.decodeImage(raw);
      if (decoded == null) throw Exception('Unsupported image');
      final side = decoded.width < decoded.height ? decoded.width : decoded.height;
      final cropped = img.copyCrop(
        decoded,
        x: (decoded.width - side) ~/ 2,
        y: (decoded.height - side) ~/ 2,
        width: side,
        height: side,
      );
      final resized = img.copyResize(cropped, width: 132, height: 132);
      final png = Uint8List.fromList(img.encodePng(resized, level: 6));
      await widget.c.api.uploadFile(_avatarPath, png);
      setState(() => _avatar = _avatarPath);
      _patchProfileConfig(widget.c);
      await widget.c.save();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Profile photo uploaded')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Upload failed: $e')));
      }
    } finally {
      if (mounted) setState(() => _avatarBusy = false);
    }
  }

  /// Hex colour field with a live swatch preview.
  Widget _colorField(String label, TextEditingController ctl) {
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: ctl,
      builder: (context, val, _) {
        Color? swatch;
        final hex = val.text.trim().replaceFirst('#', '');
        if (hex.length == 6) {
          final v = int.tryParse('FF$hex', radix: 16);
          if (v != null) swatch = Color(v);
        }
        return TextField(
          controller: ctl,
          decoration: InputDecoration(
            labelText: label,
            hintText: '#RRGGBB',
            border: const OutlineInputBorder(),
            isDense: true,
            prefixIcon: Padding(
              padding: const EdgeInsets.all(8),
              child: Container(
                width: 22,
                height: 22,
                decoration: BoxDecoration(
                  color: swatch ?? ccpPanel,
                  borderRadius: BorderRadius.circular(4),
                  border: Border.all(color: ccpMuted),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    return AnimatedBuilder(
      animation: c,
      builder: (context, _) => SettingsScaffold(
        title: 'Profile',
        onSave: () async {
          _patchProfileConfig(c);
          await c.save();
        },
        children: [
          settingCard('Profile photo', [
            Row(children: [
              ClipOval(
                child: Container(
                  width: 72,
                  height: 72,
                  color: ccpPanel,
                  child: _avatar.isEmpty
                      ? const Icon(Icons.person, color: ccpMuted, size: 36)
                      : Image.network(
                          c.api.fileUrl(_avatar).toString(),
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) =>
                              const Icon(Icons.person, color: ccpMuted, size: 36),
                        ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: OutlinedButton.icon(
                  icon: _avatarBusy
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.add_a_photo),
                  label: Text(_avatarBusy ? 'Uploading...' : 'Upload photo'),
                  onPressed: _avatarBusy ? null : _uploadAvatar,
                ),
              ),
            ]),
            const SizedBox(height: 8),
            const Text('Square PNG uploaded to the display for the Profile page.',
                style: TextStyle(color: ccpMuted, fontSize: 12)),
          ]),
          settingCard('Display owner', [
            TextField(
              controller: _name,
              decoration: const InputDecoration(
                  labelText: 'Profile name (shown on clock)',
                  border: OutlineInputBorder(),
                  isDense: true),
            ),
          ]),
          settingCard('Profile page', [
            const Text('Shown on the "Don\'t trust, verify" profile page.',
                style: TextStyle(color: ccpMuted, fontSize: 12)),
            const SizedBox(height: 8),
            TextField(
              controller: _nickname,
              decoration: const InputDecoration(
                  labelText: 'Nickname', border: OutlineInputBorder(), isDense: true),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _role,
              decoration: const InputDecoration(
                  labelText: 'Role / subtitle', border: OutlineInputBorder(), isDense: true),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _motto,
              decoration: const InputDecoration(
                  labelText: 'Motto (top-right)',
                  border: OutlineInputBorder(),
                  isDense: true),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _company,
              decoration: const InputDecoration(
                  labelText: 'Company', border: OutlineInputBorder(), isDense: true),
            ),
            SwitchListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              activeColor: ccpAccent,
              title: const Text('Show this page'),
              value: _show,
              onChanged: (v) => setState(() => _show = v),
            ),
          ]),
          settingCard('Colours', [
            const Text('Hex colour for each part of the profile page.',
                style: TextStyle(color: ccpMuted, fontSize: 12)),
            const SizedBox(height: 8),
            _colorField('Background', _bgColor),
            const SizedBox(height: 8),
            _colorField('Name', _nameColor),
            const SizedBox(height: 8),
            _colorField('Role / subtitle', _roleColor),
            const SizedBox(height: 8),
            _colorField('Company', _companyColor),
            const SizedBox(height: 8),
            _colorField('Motto', _verifyColor),
          ]),
          settingCard('Social links (QR on profile)', [
            const Text('Links shown as QR codes when you tap a social button.',
                style: TextStyle(color: ccpMuted, fontSize: 12)),
            const SizedBox(height: 8),
            TextField(
              controller: _fbUrl,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                  labelText: 'Facebook URL', border: OutlineInputBorder(), isDense: true),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _ytUrl,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                  labelText: 'YouTube URL', border: OutlineInputBorder(), isDense: true),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _ttUrl,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                  labelText: 'TikTok URL', border: OutlineInputBorder(), isDense: true),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _igUrl,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                  labelText: 'Instagram URL', border: OutlineInputBorder(), isDense: true),
            ),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              icon: _socialBusy
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.query_stats),
              label: Text(_socialBusy
                  ? 'Reading public pages...'
                  : 'Refresh public followers'),
              onPressed: _socialBusy ? null : _refreshSocialStats,
            ),
            const SizedBox(height: 8),
            _socialStatLine('Facebook', _fbFollowers, _fbFollowing, _fbSecondaryLabel),
            _socialStatLine('YouTube', _ytFollowers, _ytFollowing, _ytSecondaryLabel),
            _socialStatLine('TikTok', _ttFollowers, _ttFollowing, _ttSecondaryLabel),
            _socialStatLine('Instagram', _igFollowers, _igFollowing, _igSecondaryLabel),
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
                    if (context.mounted) {
                      // back to the welcome/login gate — login is required to use the app
                      Navigator.of(context).pushAndRemoveUntil(
                        MaterialPageRoute(builder: (_) => const AuthGate()),
                        (route) => false,
                      );
                    }
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
class ClockSettings extends StatefulWidget {
  final DeviceController c;
  const ClockSettings(this.c, {super.key});
  @override
  State<ClockSettings> createState() => _ClockSettingsState();
}

class _ClockSettingsState extends State<ClockSettings> {
  // colour presets applied by the Theme dropdown
  static const _themes = <String, Map<String, String>>{
    'Cyan': {'time': '#00D1FF', 'sec': '#FF9500', 'date': '#848E9C', 'bg': '#0B0E11'},
    'Gold': {'time': '#F0B90B', 'sec': '#FF9500', 'date': '#848E9C', 'bg': '#0B0E11'},
    'Mint': {'time': '#0ECB81', 'sec': '#A0F0D0', 'date': '#7A8A85', 'bg': '#06120E'},
    'Neon': {'time': '#FF2E97', 'sec': '#00E5FF', 'date': '#9A6A8A', 'bg': '#0A0014'},
    'Mono': {'time': '#FFFFFF', 'sec': '#BBBBBB', 'date': '#888888', 'bg': '#000000'},
  };
  static const _dateFormats = ['long', 'dmy', 'mdy', 'iso'];

  late final _s = widget.c.section('clock');
  late bool _format24h = (_s['format_24h'] as bool?) ?? true;
  late bool _showSeconds = (_s['show_seconds'] as bool?) ?? true;
  late bool _showDate = (_s['show_date'] as bool?) ?? true;
  late bool _showLogo = (_s['show_logo'] as bool?) ?? true;
  late String _dateFormat = (_s['date_format'] as String?) ?? 'long';
  late final TextEditingController _tz =
      TextEditingController(text: '${(_s['tz_offset_min'] as num?)?.toInt() ?? 420}');
  late final TextEditingController _timeColor =
      TextEditingController(text: (_s['time_color'] as String?) ?? '#00D1FF');
  late final TextEditingController _secColor =
      TextEditingController(text: (_s['sec_color'] as String?) ?? '#FF9500');
  late final TextEditingController _dateColor =
      TextEditingController(text: (_s['date_color'] as String?) ?? '#848E9C');
  late final TextEditingController _bgColor =
      TextEditingController(text: (_s['bg_color'] as String?) ?? '#0B0E11');

  void _patchClock(DeviceController c) {
    c.patch('clock', 'format_24h', _format24h);
    c.patch('clock', 'show_seconds', _showSeconds);
    c.patch('clock', 'show_date', _showDate);
    c.patch('clock', 'show_logo', _showLogo);
    c.patch('clock', 'date_format', _dateFormat);
    c.patch('clock', 'tz_offset_min', int.tryParse(_tz.text.trim()) ?? 420);
    c.patch('clock', 'time_color', _timeColor.text.trim());
    c.patch('clock', 'sec_color', _secColor.text.trim());
    c.patch('clock', 'date_color', _dateColor.text.trim());
    c.patch('clock', 'bg_color', _bgColor.text.trim());
  }

  Widget _colorField(String label, TextEditingController ctl) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: ValueListenableBuilder<TextEditingValue>(
        valueListenable: ctl,
        builder: (context, val, _) {
          Color? swatch;
          final hex = val.text.trim().replaceFirst('#', '');
          if (hex.length == 6) {
            final v = int.tryParse('FF$hex', radix: 16);
            if (v != null) swatch = Color(v);
          }
          return TextField(
            controller: ctl,
            decoration: InputDecoration(
              labelText: label,
              hintText: '#RRGGBB',
              border: const OutlineInputBorder(),
              isDense: true,
              prefixIcon: Padding(
                padding: const EdgeInsets.all(8),
                child: Container(
                  width: 22,
                  height: 22,
                  decoration: BoxDecoration(
                    color: swatch ?? ccpPanel,
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(color: ccpMuted),
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    return AnimatedBuilder(
      animation: c,
      builder: (context, _) => SettingsScaffold(
        title: 'Clock',
        onSave: () async {
          _patchClock(c);
          await c.save();
        },
        children: [
          settingCard('Time & date', [
            SwitchListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              activeColor: ccpAccent,
              title: const Text('24-hour clock'),
              subtitle: Text(_format24h ? 'e.g. 14:30' : 'e.g. 2:30 PM',
                  style: const TextStyle(color: ccpMuted, fontSize: 12)),
              value: _format24h,
              onChanged: (v) => setState(() => _format24h = v),
            ),
            settingRow<String>('Date format', _dateFormat, _dateFormats,
                (v) => setState(() => _dateFormat = v),
                fmt: (v) => const {
                      'long': 'Wed 11 Jun 2026',
                      'dmy': '11/06/2026',
                      'mdy': '06/11/2026',
                      'iso': '2026-06-11',
                    }[v]!),
            SwitchListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              activeColor: ccpAccent,
              title: const Text('Show seconds'),
              value: _showSeconds,
              onChanged: (v) => setState(() => _showSeconds = v),
            ),
            SwitchListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              activeColor: ccpAccent,
              title: const Text('Show date'),
              value: _showDate,
              onChanged: (v) => setState(() => _showDate = v),
            ),
            SwitchListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              activeColor: ccpAccent,
              title: const Text('Show logo'),
              value: _showLogo,
              onChanged: (v) => setState(() => _showLogo = v),
            ),
          ]),
          settingCard('Colours', [
            settingRow<String>('Theme preset', 'Custom',
                ['Custom', ..._themes.keys], (v) {
              final t = _themes[v];
              if (t == null) return;
              setState(() {
                _timeColor.text = t['time']!;
                _secColor.text = t['sec']!;
                _dateColor.text = t['date']!;
                _bgColor.text = t['bg']!;
              });
            }),
            _colorField('Time colour', _timeColor),
            _colorField('Seconds / AM·PM colour', _secColor),
            _colorField('Date colour', _dateColor),
            _colorField('Background', _bgColor),
          ]),
          settingCard('Display', [
            Row(children: [
              const Icon(Icons.brightness_6, size: 18, color: ccpMuted),
              Expanded(
                child: Slider(
                  min: 5,
                  max: 100,
                  divisions: 19,
                  value: c.brightness.clamp(5, 100).toDouble(),
                  label: '${c.brightness.round()}%',
                  activeColor: ccpAccent,
                  onChanged: (v) => c.setBrightness(v),
                ),
              ),
              Text('${c.brightness.round()}%',
                  style: const TextStyle(color: ccpMuted)),
            ]),
            const SizedBox(height: 8),
            TextField(
              controller: _tz,
              keyboardType:
                  const TextInputType.numberWithOptions(signed: true),
              decoration: const InputDecoration(
                labelText: 'Timezone offset (minutes from UTC)',
                helperText: 'Bangkok = 420, London = 0, New York = -300',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
          ]),
          _alarmCard(context, c),
        ],
      ),
    );
  }

  Widget _alarmCard(BuildContext context, DeviceController c) {
    final alarms = c.alarms;
    return settingCard('Alarm (${alarms.length}/${DeviceController.maxAlarms})', [
      if (c.userEmail == null) ...[
        const Text('Login (Profile tab) to manage alarms.',
            style: TextStyle(color: ccpMuted)),
      ] else if (!c.alarmUnlocked) ...[
        lockedFeature(context, c, 'clock-alarm'),
      ] else ...[
        if (alarms.isEmpty)
          const Text('No alarms yet.',
              style: TextStyle(color: ccpMuted, fontSize: 12)),
        ...alarms.asMap().entries.map((e) {
          final a = e.value;
          final on = a['enabled'] != false;
          final days = (a['days'] as List?)?.cast<int>() ?? const [];
          return ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.alarm,
                color: on ? ccpAccent : ccpMuted),
            title: Text('${a['time'] ?? '--:--'}'
                '${(a['label'] as String?)?.isNotEmpty == true ? '  ·  ${a['label']}' : ''}'),
            subtitle: Text(_daysLabel(days),
                style: const TextStyle(color: ccpMuted, fontSize: 12)),
            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
              Switch(
                value: on,
                activeColor: ccpAccent,
                onChanged: (v) {
                  final list = c.alarms;
                  list[e.key]['enabled'] = v;
                  c.patch('clock', 'alarms', list);
                },
              ),
              IconButton(
                icon: const Icon(Icons.delete_outline,
                    color: Colors.redAccent, size: 20),
                onPressed: () =>
                    c.patch('clock', 'alarms', c.alarms..removeAt(e.key)),
              ),
            ]),
            onTap: () => _editAlarm(context, c, existing: a, index: e.key),
          );
        }),
        if (alarms.length < DeviceController.maxAlarms)
          OutlinedButton.icon(
            icon: const Icon(Icons.add_alarm),
            label: const Text('Add alarm'),
            onPressed: () => _editAlarm(context, c),
          ),
        const Text(
            'Tap "Save to display" to apply. On the display: Snooze or Stop.',
            style: TextStyle(color: ccpMuted, fontSize: 12)),
      ],
    ]);
  }

  static String _daysLabel(List<int> days) {
    if (days.isEmpty) return 'Once';
    if (days.length == 7) return 'Every day';
    const names = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    final sorted = [...days]..sort();
    if (sorted.toString() == [1, 2, 3, 4, 5].toString()) return 'Weekdays';
    if (sorted.toString() == [6, 7].toString()) return 'Weekends';
    return sorted.map((d) => names[d]).join(' ');
  }

  Future<void> _editAlarm(BuildContext context, DeviceController c,
      {Map<String, dynamic>? existing, int? index}) async {
    var time = (existing?['time'] as String?) ?? '07:00';
    final parts = time.split(':');
    var tod = TimeOfDay(
        hour: int.tryParse(parts.first) ?? 7,
        minute: int.tryParse(parts.length > 1 ? parts[1] : '0') ?? 0);
    final days = <int>{...((existing?['days'] as List?)?.cast<int>() ?? const [])};
    final labelCtl =
        TextEditingController(text: (existing?['label'] as String?) ?? '');
    var sound = (existing?['sound'] as String?) ?? 'beep';
    var enabled = existing?['enabled'] != false;
    const dayNames = ['', 'M', 'T', 'W', 'T', 'F', 'S', 'S'];

    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (d) => StatefulBuilder(
        builder: (d, setD) => AlertDialog(
          title: Text(index == null ? 'New alarm' : 'Edit alarm'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              OutlinedButton.icon(
                icon: const Icon(Icons.schedule),
                label: Text(tod.format(d),
                    style: const TextStyle(fontSize: 22)),
                onPressed: () async {
                  final picked =
                      await showTimePicker(context: d, initialTime: tod);
                  if (picked != null) setD(() => tod = picked);
                },
              ),
              const SizedBox(height: 8),
              Wrap(spacing: 4, children: [
                for (var i = 1; i <= 7; i++)
                  FilterChip(
                    label: Text(dayNames[i]),
                    selected: days.contains(i),
                    onSelected: (s) =>
                        setD(() => s ? days.add(i) : days.remove(i)),
                  ),
              ]),
              const SizedBox(height: 4),
              const Text('No days = ring once at the next occurrence.',
                  style: TextStyle(color: ccpMuted, fontSize: 11)),
              const SizedBox(height: 8),
              TextField(
                controller: labelCtl,
                decoration: const InputDecoration(
                    labelText: 'Label (optional)', isDense: true),
              ),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                initialValue:
                    const ['beep', 'chime', 'siren'].contains(sound)
                        ? sound
                        : 'beep',
                decoration:
                    const InputDecoration(labelText: 'Sound', isDense: true),
                items: const [
                  DropdownMenuItem(value: 'beep', child: Text('Beep')),
                  DropdownMenuItem(value: 'chime', child: Text('Chime')),
                  DropdownMenuItem(value: 'siren', child: Text('Siren')),
                ],
                onChanged: (v) => setD(() => sound = v ?? 'beep'),
              ),
              SwitchListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                activeColor: ccpAccent,
                title: const Text('Enabled'),
                value: enabled,
                onChanged: (v) => setD(() => enabled = v),
              ),
            ]),
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(d), child: const Text('Cancel')),
            FilledButton(
              onPressed: () {
                final hh = tod.hour.toString().padLeft(2, '0');
                final mm = tod.minute.toString().padLeft(2, '0');
                Navigator.pop(d, {
                  'time': '$hh:$mm',
                  'days': days.toList()..sort(),
                  'label': labelCtl.text.trim(),
                  'sound': sound,
                  'enabled': enabled,
                  'snooze': 5,
                });
              },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
    if (result == null) return;
    final list = c.alarms;
    if (index == null) {
      list.add(result);
    } else {
      list[index] = result;
    }
    c.patch('clock', 'alarms', list);
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
