import 'dart:convert';
import 'dart:typed_data';
import 'package:http/http.dart' as http;

class DeviceFile {
  final String name;
  final int size;
  DeviceFile(this.name, this.size);
}

class FileListResult {
  final bool sdMounted;
  final List<DeviceFile> files;
  FileListResult(this.sdMounted, this.files);
}

/// Thin client for the display's LAN API (see docs/manual.md §5).
class DeviceApi {
  final String host;
  DeviceApi(this.host);

  Uri _u(String path) => Uri.parse('http://$host$path');

  Future<Map<String, dynamic>> info() async {
    final res = await http.get(_u('/api/v1/info')).timeout(const Duration(seconds: 5));
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> getConfig() async {
    final res = await http.get(_u('/api/v1/config')).timeout(const Duration(seconds: 5));
    return jsonDecode(res.body.isEmpty ? '{}' : res.body) as Map<String, dynamic>;
  }

  Future<void> setConfig(Map<String, dynamic> config) async {
    await http.post(_u('/api/v1/config'),
        headers: {'Content-Type': 'application/json'}, body: jsonEncode(config));
  }

  Future<void> setBrightness(int value) async {
    await http.post(_u('/api/v1/brightness'), body: jsonEncode({'value': value}));
  }

  Future<void> identify() => http.post(_u('/api/v1/identify'));

  Future<void> wifiReset() => http.post(_u('/api/v1/wifi/reset'));

  /* ---- SD card files (slideshow photos etc.) ---- */

  Future<FileListResult> listFiles(String dir) async {
    final res = await http
        .get(_u('/api/v1/files?dir=$dir'))
        .timeout(const Duration(seconds: 8));
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    final files = ((json['files'] as List?) ?? [])
        .map((f) => DeviceFile(f['name'] as String, (f['size'] as num).toInt()))
        .toList();
    return FileListResult(json['sd_mounted'] == true, files);
  }

  Uri fileUrl(String path) => _u('/api/v1/file?path=${Uri.encodeQueryComponent(path)}');

  Future<void> uploadFile(String path, Uint8List bytes) async {
    final res = await http
        .post(_u('/api/v1/upload?path=$path'),
            headers: {'Content-Type': 'application/octet-stream'}, body: bytes)
        .timeout(const Duration(seconds: 30));
    if (res.statusCode >= 300) {
      throw Exception('HTTP ${res.statusCode}: ${res.body}');
    }
  }

  Future<void> deleteFile(String path) async {
    await http.post(_u('/api/v1/delete'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'path': path}));
  }
}
