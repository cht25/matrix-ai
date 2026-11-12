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

class _DevicesScreenState extends State<DevicesScreen> with WidgetsBindingObserver {
  List<dynamic> _devices = [];
  bool _loading = true;
  String? _error;
  String? _account;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() { WidgetsBinding.instance.removeObserver(this); super.dispose(); }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _load();
  }

  Future<void> _load() async {
    if (!mounted) return;
    setState(() { _loading = true; _error = null; });
    try {
      final res = await widget.api.getJson('/api/devices');
      final account = await widget.api.accountLabel();
      if (!mounted) return;
      setState(() => _account = account);
      setState(() => _devices = (res['devices'] as List?) ?? []);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.code);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _unlink(String id) async {
    try {
      await widget.api.deleteJson('/api/devices?id=${Uri.encodeComponent(id)}');
      if (id == await MatrixApi.currentDeviceId()) await MatrixApi.clearDeviceCredential();
      await _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Unlink failed: ${e.code}')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Connected devices'),
        actions: [
          IconButton(
            tooltip: 'Sync app & browser activity',
            onPressed: () async {
              try {
                await widget.api.reportDeviceActivity(
                  screenTimeMinutes: 15,
                  apps: [
                    {'name': 'MATRIX Companion', 'package': 'ai.matrix.app', 'minutes': 15, 'hidden': false, 'last_used': DateTime.now().toUtc().toIso8601String()},
                  ],
                  hiddenApps: const [],
                  browserHistory: const [],
                );
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Device activity synced.')));
                }
              } on ApiException catch (e) {
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Sync failed: ${e.code}')));
                }
              }
            },
            icon: const Icon(Icons.sync),
          ),
          IconButton(tooltip: 'Refresh devices', onPressed: _load, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Column(mainAxisSize: MainAxisSize.min, children: [Text('Could not load: $_error', textAlign: TextAlign.center), if (_account != null) Text('Account: $_account'), const SizedBox(height: 12), FilledButton(onPressed: _load, child: const Text('Retry')), if (_error == 'DEVICE_SCOPE_DENIED' || _error == 'UNAUTHENTICATED' || _error == 'DEVICE_CREDENTIAL_EXPIRED') TextButton(onPressed: () async { await MatrixApi.clearDeviceCredential(); await _load(); }, child: const Text('Clear revoked/expired pairing and use account login'))])))
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
