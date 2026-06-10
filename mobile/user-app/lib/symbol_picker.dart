import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'main.dart' show ccpAccent, ccpMuted, ccpPanel;

/// Bottom sheet: pick a Binance USDT pair. Loads the full ticker list once
/// (~2000 symbols), filters to *USDT, searchable, shows 10 at a time with
/// a "load more" row.
Future<String?> showSymbolPicker(BuildContext context) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    backgroundColor: ccpPanel,
    builder: (_) => const _SymbolPickerSheet(),
  );
}

class _SymbolPickerSheet extends StatefulWidget {
  const _SymbolPickerSheet();
  @override
  State<_SymbolPickerSheet> createState() => _SymbolPickerSheetState();
}

class _SymbolPickerSheetState extends State<_SymbolPickerSheet> {
  List<String> _all = [];
  String _query = '';
  int _shown = 10;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    try {
      final res = await http
          .get(Uri.parse('https://api.binance.com/api/v3/ticker/price'))
          .timeout(const Duration(seconds: 10));
      final list = (jsonDecode(res.body) as List)
          .map((e) => e['symbol'] as String)
          .where((s) => s.endsWith('USDT'))
          .toList()
        ..sort();
      setState(() {
        _all = list;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _all
        .where((s) => s.toLowerCase().contains(_query.toLowerCase()))
        .toList();
    final visible = filtered.take(_shown).toList();

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.75,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: TextField(
              autofocus: false,
              decoration: const InputDecoration(
                hintText: 'Search coin (e.g. BTC, SOL, DOGE)',
                prefixIcon: Icon(Icons.search),
                border: OutlineInputBorder(),
                isDense: true,
              ),
              onChanged: (v) => setState(() {
                _query = v;
                _shown = 10;
              }),
            ),
          ),
          if (_loading) const Expanded(child: Center(child: CircularProgressIndicator())),
          if (_error != null)
            Expanded(
                child: Center(
                    child: Text('Cannot load symbols:\n$_error',
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: ccpMuted)))),
          if (!_loading && _error == null)
            Expanded(
              child: ListView(
                children: [
                  ...visible.map((s) => ListTile(
                        dense: true,
                        title: Text(s.replaceAll('USDT', ''),
                            style: const TextStyle(fontWeight: FontWeight.bold)),
                        subtitle:
                            Text(s, style: const TextStyle(color: ccpMuted)),
                        trailing: const Icon(Icons.add, color: ccpAccent),
                        onTap: () => Navigator.pop(context, s),
                      )),
                  if (filtered.length > _shown)
                    TextButton(
                      onPressed: () => setState(() => _shown += 10),
                      child: Text(
                          'Load 10 more (${filtered.length - _shown} left)'),
                    ),
                ],
              ),
            ),
        ]),
      ),
    );
  }
}
