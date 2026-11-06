/// Device center: lists devices linked to this account and allows unlinking.
/// Shows only what the server actually registered for the account.
library;

import 'package:flutter/material.dart';
import 'api.dart';

class DevicesScreen extends StatefulWidget {
  const DevicesScreen({super.key, required this.api});
  final MatrixApi api;
  @override
  State<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends State<DevicesScreen> {
  List<dynamic> _devices = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final res = await widget.api.getJson('/api/devices');
      setState(() => _devices = (res['devices'] as List?) ?? []);
    } on ApiException catch (e) {
      setState(() => _error = e.code);
    } finally {
      setState(() => _loading = false);
    }
  }

  Future<void> _unlink(String id) async {
    try {
      await widget.api.deleteJson('/api/devices?id=${Uri.encodeComponent(id)}');
      await _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Unlink failed: ${e.code}')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Connected devices')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text('Could not load: $_error'))
              : _devices.isEmpty
                  ? const Center(child: Text('No devices linked yet. Use “Pair this device”.'))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.builder(
                        itemCount: _devices.length,
                        itemBuilder: (context, i) {
                          final d = _devices[i] as Map;
                          return ListTile(
                            leading: const Icon(Icons.smartphone),
                            title: Text(d['device_name']?.toString() ?? 'Device'),
                            subtitle: Text('${d['platform']} · ${d['device_type']} · paired ${d['paired_at']?.toString().substring(0, 10) ?? ''}'),
                            trailing: IconButton(
                              icon: const Icon(Icons.link_off, color: Colors.red),
                              onPressed: () => _unlink(d['id'].toString()),
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}
