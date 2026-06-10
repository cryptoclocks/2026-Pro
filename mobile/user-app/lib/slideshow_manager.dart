import 'dart:io';
import 'package:flutter/material.dart';
import 'package:image/image.dart' as img;
import 'package:image_picker/image_picker.dart';
import 'device_api.dart';
import 'main.dart' show ccpAccent, ccpMuted, ccpPanel;

/// Manage slideshow photos on the display's SD card:
/// upload from the phone gallery, delete, drag to reorder.
/// Pops with the new order list (caller saves it into the config).
class SlideshowManager extends StatefulWidget {
  final DeviceApi api;
  const SlideshowManager({super.key, required this.api});

  @override
  State<SlideshowManager> createState() => _SlideshowManagerState();
}

class _SlideshowManagerState extends State<SlideshowManager> {
  static const _dir = 'pages/slideshow/assets';
  List<String> _files = [];
  bool _busy = false;
  bool _sdMounted = true;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    final res = await widget.api.listFiles(_dir);
    setState(() {
      _sdMounted = res.sdMounted;
      // keep existing order for files we already know, append new ones
      final names = res.files.map((f) => f.name).toList();
      _files = [
        ..._files.where(names.contains),
        ...names.where((n) => !_files.contains(n)),
      ];
    });
  }

  Future<void> _upload() async {
    final picker = ImagePicker();
    final picked = await picker.pickImage(source: ImageSource.gallery);
    if (picked == null) return;
    setState(() => _busy = true);
    try {
      // Decode, fit to the 480x320 panel, re-encode as PNG. The display's
      // PNG decoder is reliable; its JPEG path is not.
      final raw = await File(picked.path).readAsBytes();
      final decoded = img.decodeImage(raw);
      if (decoded == null) throw Exception('Unsupported image');
      final fitted = img.copyResize(decoded,
          width: 480, height: 320, maintainAspect: true,
          backgroundColor: img.ColorRgb8(0, 0, 0));
      final png = img.encodePng(fitted, level: 6);
      final name = 'p${DateTime.now().millisecondsSinceEpoch % 100000}.png';
      await widget.api.uploadFile('$_dir/$name', png);
      await _refresh();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Upload failed: $e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete(String name) async {
    await widget.api.deleteFile('$_dir/$name');
    setState(() => _files.remove(name));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Slideshow photos', style: TextStyle(color: ccpAccent)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, _files),
            child: const Text('Done'),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _busy || !_sdMounted ? null : _upload,
        backgroundColor: ccpAccent,
        icon: _busy
            ? const SizedBox(
                width: 18, height: 18,
                child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black))
            : const Icon(Icons.add_photo_alternate, color: Colors.black),
        label: const Text('Upload', style: TextStyle(color: Colors.black)),
      ),
      body: !_sdMounted
          ? const Center(
              child: Text('No SD card in the display.\nInsert one and try again.',
                  textAlign: TextAlign.center, style: TextStyle(color: ccpMuted)))
          : _files.isEmpty
              ? const Center(
                  child: Text('No photos yet — upload from your gallery.\n(320x240 works best)',
                      textAlign: TextAlign.center, style: TextStyle(color: ccpMuted)))
              : ReorderableListView.builder(
                  padding: const EdgeInsets.all(12),
                  itemCount: _files.length,
                  onReorder: (from, to) {
                    setState(() {
                      if (to > from) to--;
                      final item = _files.removeAt(from);
                      _files.insert(to, item);
                    });
                  },
                  itemBuilder: (_, i) {
                    final name = _files[i];
                    return Card(
                      key: ValueKey(name),
                      color: ccpPanel,
                      child: ListTile(
                        leading: const Icon(Icons.image, color: ccpAccent),
                        title: Text(name),
                        subtitle: Text('position ${i + 1}',
                            style: const TextStyle(color: ccpMuted)),
                        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                          IconButton(
                            icon: const Icon(Icons.delete_outline, color: Colors.redAccent),
                            onPressed: () => _delete(name),
                          ),
                          const Icon(Icons.drag_handle, color: ccpMuted),
                        ]),
                      ),
                    );
                  },
                ),
    );
  }
}
