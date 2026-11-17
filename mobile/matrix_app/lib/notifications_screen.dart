/// Android Notification Sync, Assistant Setup, Consent-Based MediaProjection
/// Mirroring & Cross-Device Command Execution Screen.
library;

import 'dart:async';
import 'package:flutter/material.dart';
import 'api.dart';
import 'native_bridge.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key, required this.api});
  final MatrixApi api;

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> with WidgetsBindingObserver {
  bool _notifAccess = false;
  bool _mirrorActive = false;
  String? _activeMirrorSessionId;
  List<dynamic> _synced = [];
  List<dynamic> _pendingMirror = [];
  Map<String, dynamic> _deviceStatus = {};
  String? _statusMsg;
  bool _loading = true;
  StreamSubscription<Map<String, dynamic>>? _eventSub;
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _eventSub = NativeBridge.instance.events.listen(_onNativeEvent);
    _load();
    _pollTimer = Timer.periodic(const Duration(seconds: 6), (_) => _pollCommandsAndMirror());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _eventSub?.cancel();
    _pollTimer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _load();
    }
  }

  void _onNativeEvent(Map<String, dynamic> event) {
    final type = event['type']?.toString();
    final data = event['data'] is Map ? Map<String, dynamic>.from(event['data'] as Map) : <String, dynamic>{};

    if (type == 'notification_posted') {
      _syncSingleNotification(data);
    } else if (type == 'mirror_frame' && _activeMirrorSessionId != null) {
      final dataUrl = data['data_url']?.toString();
      if (dataUrl != null && dataUrl.isNotEmpty) {
        widget.api.postMirrorSignal(
          sessionId: _activeMirrorSessionId!,
          fromRole: 'source',
          kind: 'snapshot',
          payload: {'data_url': dataUrl},
        ).catchError((_) => <String, dynamic>{});
      }
    } else if (type == 'mirror_stopped') {
      if (_activeMirrorSessionId != null) {
        widget.api.stopMirrorSession(_activeMirrorSessionId!, 'android_service_stopped').catchError((_) => <String, dynamic>{});
      }
      if (mounted) {
        setState(() {
          _mirrorActive = false;
          _activeMirrorSessionId = null;
        });
      }
    }
  }

  Future<void> _syncSingleNotification(Map<String, dynamic> item) async {
    try {
      final devId = await MatrixApi.currentDeviceId();
      await widget.api.ingestSyncedNotification({
        if (devId != null) 'source_device_id': devId,
        'source_device_name': _deviceStatus['device_model']?.toString() ?? 'Android Phone',
        'source_platform': 'android',
        'package_name': item['package_name']?.toString() ?? 'unknown',
        'app_name': item['app_name']?.toString() ?? 'App',
        'title': item['title']?.toString() ?? 'Notification',
        'body': item['body']?.toString() ?? '',
        'external_key': item['external_key']?.toString() ?? '',
      });
      await _load();
    } catch (_) {}
  }

  Future<void> _load() async {
    final access = await NativeBridge.instance.isNotificationAccessEnabled();
    final status = await NativeBridge.instance.getDeviceStatus();
    List<dynamic> synced = _synced;
    List<dynamic> mirror = [];
    try {
      final res = await widget.api.listSyncedNotifications(limit: 40);
      synced = (res['items'] as List?) ?? [];
    } catch (_) {}
    try {
      final m = await widget.api.listMirrorSessions();
      final all = (m['sessions'] as List?) ?? [];
      mirror = all.where((s) => s is Map && s['status'] == 'awaiting_source_consent').toList();
    } catch (_) {}

    if (!mounted) return;
    setState(() {
      _notifAccess = access;
      _deviceStatus = status;
      _mirrorActive = status['mirror_active'] == true;
      _synced = synced;
      _pendingMirror = mirror;
      _loading = false;
    });
  }

  Future<void> _pollCommandsAndMirror() async {
    try {
      final devId = await MatrixApi.currentDeviceId();
      final cmdRes = await widget.api.pollDeviceCommands(targetDeviceId: devId);
      final cmds = (cmdRes['commands'] as List?) ?? [];
      for (final raw in cmds) {
        if (raw is! Map) continue;
        final id = raw['command_id']?.toString() ?? '';
        final command = raw['command']?.toString() ?? '';
        final args = raw['args'] is Map ? Map<String, dynamic>.from(raw['args'] as Map) : <String, dynamic>{};
        if (id.isEmpty) continue;

        if (command == 'dismiss_notification') {
          final key = args['external_key']?.toString() ?? '';
          final ok = key.isNotEmpty && await NativeBridge.instance.dismissSystemNotification(key);
          await widget.api.reportDeviceCommandResult(
            commandId: id,
            ok: ok,
            status: ok ? 'executed' : 'not_supported',
            message: ok ? 'Dismissed Android notification' : 'Notification already cleared or unavailable',
          );
        } else if (command == 'open_app') {
          final res = await NativeBridge.instance.openInstalledApp(args['app_name']?.toString() ?? '');
          await widget.api.reportDeviceCommandResult(
            commandId: id,
            ok: res['ok'] == true,
            status: res['status']?.toString() ?? 'failed',
            message: res['message']?.toString() ?? '',
          );
        } else if (command == 'media_control') {
          final res = await NativeBridge.instance.mediaControl(args['action']?.toString() ?? 'play_pause');
          await widget.api.reportDeviceCommandResult(
            commandId: id,
            ok: res['ok'] == true,
            status: res['status']?.toString() ?? 'failed',
            message: res['message']?.toString() ?? '',
          );
        } else if (command == 'device_status_ping') {
          final st = await NativeBridge.instance.getDeviceStatus();
          await widget.api.reportDeviceCommandResult(
            commandId: id,
            ok: true,
            status: 'executed',
            message: 'Battery ${st['battery_percent']}% (${st['charging'] == true ? 'charging' : 'on battery'})',
          );
        }
      }
    } catch (_) {}

    try {
      final m = await widget.api.listMirrorSessions();
      final all = (m['sessions'] as List?) ?? [];
      final awaiting = all.where((s) => s is Map && s['status'] == 'awaiting_source_consent').toList();
      if (mounted) {
        setState(() => _pendingMirror = awaiting);
      }
    } catch (_) {}
  }

  Future<void> _syncSnapshotNow() async {
    final active = await NativeBridge.instance.listActiveNotifications();
    var count = 0;
    for (final item in active.take(15)) {
      await _syncSingleNotification(item);
      count++;
    }
    if (mounted) {
      setState(() => _statusMsg = 'Synced $count active notification(s).');
    }
  }

  Future<void> _respondMirror(Map session, bool accept) async {
    final id = session['session_id']?.toString() ?? '';
    if (id.isEmpty) return;
    if (!accept) {
      await widget.api.respondMirrorConsent(sessionId: id, accept: false);
      await _load();
      return;
    }
    final granted = await NativeBridge.instance.requestScreenMirrorCapture();
    if (!granted) {
      if (mounted) {
        setState(() => _statusMsg = 'Screen capture permission was cancelled.');
      }
      return;
    }
    await widget.api.respondMirrorConsent(sessionId: id, accept: true, allowRemoteControl: false);
    if (mounted) {
      setState(() {
        _mirrorActive = true;
        _activeMirrorSessionId = id;
        _statusMsg = 'Screen mirroring active (view-only). Tap Stop anytime.';
      });
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Alerts & Mirror'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load, tooltip: 'Refresh'),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(14),
          children: [
            if (_statusMsg != null)
              Card(
                color: const Color(0xFF17251E),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(_statusMsg!, style: const TextStyle(fontSize: 13)),
                ),
              ),
            if (_mirrorActive && _activeMirrorSessionId != null)
              Card(
                color: const Color(0xFF3A181A),
                child: ListTile(
                  leading: const Icon(Icons.cast_connected, color: Colors.redAccent),
                  title: const Text('Screen Mirroring Active'),
                  subtitle: const Text('Your screen is being shared with your consented session.'),
                  trailing: FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: Colors.redAccent),
                    onPressed: () async {
                      await NativeBridge.instance.stopScreenMirrorCapture();
                      await widget.api.stopMirrorSession(_activeMirrorSessionId!);
                      setState(() {
                        _mirrorActive = false;
                        _activeMirrorSessionId = null;
                      });
                    },
                    child: const Text('Stop'),
                  ),
                ),
              ),
            if (_pendingMirror.isNotEmpty)
              ..._pendingMirror.map((raw) {
                final s = raw as Map;
                return Card(
                  color: const Color(0xFF2B2214),
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('Incoming Screen Mirror Consent Request', style: TextStyle(fontWeight: FontWeight.bold)),
                        const SizedBox(height: 6),
                        Text('Share ${s['source_device_name'] ?? 'this phone'} screen (View-Only)?'),
                        const SizedBox(height: 10),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.end,
                          children: [
                            TextButton(onPressed: () => _respondMirror(s, false), child: const Text('Decline')),
                            const SizedBox(width: 8),
                            FilledButton(onPressed: () => _respondMirror(s, true), child: const Text('Share Screen')),
                          ],
                        ),
                      ],
                    ),
                  ),
                );
              }),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(_notifAccess ? Icons.notifications_active : Icons.notifications_off, size: 20),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _notifAccess ? 'Notification Access Enabled' : 'Notification Access Disabled',
                            style: const TextStyle(fontWeight: FontWeight.w700),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      _notifAccess
                          ? 'Active notifications can sync across your QORVYNA devices.'
                          : 'Grant Notification Access in Android Settings to sync notifications across devices.',
                      style: const TextStyle(fontSize: 12, color: Colors.white70),
                    ),
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        OutlinedButton(
                          onPressed: () => NativeBridge.instance.openNotificationAccessSettings(),
                          child: const Text('Notification Settings'),
                        ),
                        OutlinedButton(
                          onPressed: () => NativeBridge.instance.openAssistantSettings(),
                          child: const Text('Default Assistant'),
                        ),
                        if (_notifAccess)
                          FilledButton(
                            onPressed: _syncSnapshotNow,
                            child: const Text('Sync Now'),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 10),
            Text('Synced Notifications (${_synced.length})', style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            if (_loading)
              const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()))
            else if (_synced.isEmpty)
              const Card(
                child: Padding(
                  padding: EdgeInsets.all(16),
                  child: Text('No synced notifications yet.', style: TextStyle(color: Colors.white60)),
                ),
              )
            else
              ..._synced.map((raw) {
                final n = raw as Map;
                final id = n['id']?.toString() ?? '';
                return Card(
                  child: ListTile(
                    title: Text('${n['app_name'] ?? 'App'}: ${n['title'] ?? ''}'),
                    subtitle: Text('${n['body'] ?? ''}\n${n['source_device_name'] ?? ''}', maxLines: 3),
                    isThreeLine: true,
                    trailing: IconButton(
                      icon: const Icon(Icons.close, size: 18),
                      onPressed: id.isEmpty
                          ? null
                          : () async {
                              await widget.api.dismissSyncedNotification(id);
                              await _load();
                            },
                    ),
                  ),
                );
              }),
          ],
        ),
      ),
    );
  }
}
