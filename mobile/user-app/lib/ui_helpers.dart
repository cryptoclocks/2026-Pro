import 'package:flutter/material.dart';
import 'main.dart' show ccpAccent, ccpMuted, ccpPanel;

/// A labelled dropdown row used across the settings screens.
Widget settingRow<T>(String label, T value, List<T> options,
    ValueChanged<T> onChanged,
    {String Function(T)? fmt}) {
  return Padding(
    padding: const EdgeInsets.symmetric(vertical: 2),
    child: Row(children: [
      Expanded(child: Text(label, style: const TextStyle(color: ccpMuted))),
      DropdownButton<T>(
        value: options.contains(value) ? value : options.first,
        dropdownColor: ccpPanel,
        items: options
            .map((o) =>
                DropdownMenuItem(value: o, child: Text(fmt?.call(o) ?? '$o')))
            .toList(),
        onChanged: (v) => v != null ? onChanged(v) : null,
      ),
    ]),
  );
}

/// A card section with a title.
Widget settingCard(String title, List<Widget> children) {
  return Card(
    color: ccpPanel,
    margin: const EdgeInsets.only(bottom: 12),
    child: Padding(
      padding: const EdgeInsets.all(14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title,
            style: const TextStyle(
                color: ccpAccent, fontWeight: FontWeight.bold, fontSize: 16)),
        const SizedBox(height: 10),
        ...children,
      ]),
    ),
  );
}

/// Standard scaffold for a per-page settings screen with a Save button.
class SettingsScaffold extends StatelessWidget {
  final String title;
  final List<Widget> children;
  final Future<void> Function() onSave;
  const SettingsScaffold(
      {super.key,
      required this.title,
      required this.children,
      required this.onSave});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title, style: const TextStyle(color: ccpAccent))),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        ...children,
        const SizedBox(height: 8),
        FilledButton.icon(
          icon: const Icon(Icons.save),
          label: const Text('Save to display'),
          onPressed: () async {
            await onSave();
            if (context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                  content: Text('Saved — display reloading')));
              Navigator.pop(context);
            }
          },
        ),
        const SizedBox(height: 24),
      ]),
    );
  }
}
