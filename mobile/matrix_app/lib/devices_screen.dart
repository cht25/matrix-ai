/// Devices: this phone's registration (Child of a Parent device) and the
/// devices registered to the account. Everything shown comes from the server.
library;

import 'package:flutter/material.dart';
import 'api.dart';
import 'pairing_screen.dart';

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
  bool _registered = false;
  String? _selfName;
  String? _selfStatus;
  String? _parentName;
  String? _currentDeviceId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _load();
  }

  static String _explain(String code) {
    switch (code) {
      case 'DEVICE_SCOPE_DENIED':
        return 'The Parent device has not allowed this phone to see the device list.';
      case 'UNAUTHENTICATED':
      case 'DEVICE_CREDENTIAL_EXPIRED':
      case 'DEVICE_CREDENTIAL_INVALID':
        return 'This phone is no longer connected. It may have been disconnected or removed by the Parent device.';
      case 'PAIRING_ACCOUNT_MISMATCH':
        return 'This phone was registered under a different account.';
      default:
        return 'Devices could not be loaded. Check your connection and try again.';
    }
  }

  Future<void> _load() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    final registered = await MatrixApi.hasDeviceCredential();
    final currentId = await MatrixApi.currentDeviceId();
    String? selfName;
    String? selfStatus;
    String? parentName;
    String? error;
    List<dynamic> devices = [];

    if (registered) {
      try {
        final self = await widget.api.deviceSelf();
        final device = self['device'] as Map?;
        final parent = self['parent'] as Map?;
        selfName = device?['device_name']?.toString();
        selfStatus = device?['status']?.toString();
        parentName = parent?['device_name']?.toString();
      } on ApiException catch (e) {
        // A missing "See devices" permission still means the phone is connected.
        if (e.code != 'DEVICE_SCOPE_DENIED') error = _explain(e.code);
      } catch (_) {
        error = _explain('NETWORK');
      }
    }
    if (error == null) {
      try {
        final res = await widget.api.getJson('/api/devices');
        devices = (res['devices'] as List?) ?? [];
      } on ApiException catch (e) {
        if (!(registered && e.code == 'DEVICE_SCOPE_DENIED')) error = _explain(e.code);
      } catch (_) {
        error = _explain('NETWORK');
      }
    }
    if (!mounted) return;
    setState(() {
      _registered = registered;
      _currentDeviceId = currentId;
      _selfName = selfName;
      _selfStatus = selfStatus;
      _parentName = parentName;
      _devices = devices;
      _error = error;
      _loading = false;
    });
  }

  Future<void> _openPairing() async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => PairingScreen(api: widget.api)));
    await _load();
  }

  Future<void> _forgetRegistration() async {
    await MatrixApi.clearDeviceCredential();
    await _load();
  }

  Widget _thisDeviceCard() {
    if (!_registered) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('This phone', style: TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              const Text('Not registered yet. Register it as a Child by scanning the QR shown on a Parent device.', style: TextStyle(color: Colors.white70)),
              const SizedBox(height: 12),
              FilledButton.icon(onPressed: _openPairing, icon: const Icon(Icons.qr_code_scanner), label: const Text('Register as Child')),
            ],
          ),
        ),
      );
    }
    final connected = _error == null;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(_selfName ?? 'This phone', style: const TextStyle(fontWeight: FontWeight.w700))),
                if (connected) Chip(label: Text(_selfStatus == 'online' || _selfStatus == null ? 'Connected' : _selfStatus!), visualDensity: VisualDensity.compact),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              connected
                  ? (_parentName != null ? 'Child device · connected to $_parentName' : 'Child device')
                  : _error!,
              style: const TextStyle(color: Colors.white70),
            ),
            if (!connected) ...[
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                children: [
                  OutlinedButton(onPressed: _load, child: const Text('Try again')),
                  TextButton(onPressed: _forgetRegistration, child: const Text('Forget this registration')),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _devices.isEmpty && !_registered) {
      return const Center(child: CircularProgressIndicator());
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          _thisDeviceCard(),
          if (!_registered && _error != null)
            Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                children: [
                  Text(_error!, textAlign: TextAlign.center),
                  const SizedBox(height: 8),
                  OutlinedButton(onPressed: _load, child: const Text('Try again')),
                ],
              ),
            ),
          if (_devices.isNotEmpty)
            const Padding(
              padding: EdgeInsets.fromLTRB(8, 16, 8, 4),
              child: Text('Registered devices', style: TextStyle(fontWeight: FontWeight.w600)),
            ),
          for (final item in _devices)
            Builder(builder: (context) {
              final d = item as Map;
              final id = d['id']?.toString() ?? '';
              final paired = d['paired_at']?.toString() ?? '';
              final date = paired.length >= 10 ? paired.substring(0, 10) : paired;
              return ListTile(
                leading: Icon(d['platform'] == 'android' ? Icons.smartphone : Icons.computer),
                title: Text(d['device_name']?.toString() ?? 'Device'),
                subtitle: Text([
                  if (id == _currentDeviceId) 'This phone',
                  d['platform']?.toString() ?? '',
                  if (date.isNotEmpty) 'registered $date',
                ].where((part) => part.isNotEmpty).join(' · ')),
              );
            }),
          if (_devices.isEmpty && _error == null && !_loading)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('No other devices to show.', textAlign: TextAlign.center, style: TextStyle(color: Colors.white54)),
            ),
        ],
      ),
    );
  }
}
