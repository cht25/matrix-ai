/// Wear OS screens: sign-in (email+password on watch, or rely on the phone
/// companion session), quick voice/text chat with short answers, synced
/// notification glance feed, and device status.
library;

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:matrix_app/api.dart';

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------
class WearLoginScreen extends StatefulWidget {
  const WearLoginScreen({super.key});
  @override
  State<WearLoginScreen> createState() => _WearLoginScreenState();
}

class _WearLoginScreenState extends State<WearLoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _signIn() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await FirebaseAuth.instance.signInWithEmailAndPassword(
        email: _email.text.trim(),
        password: _password.text,
      );
    } on FirebaseAuthException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Text('QORVYNA', style: TextStyle(fontWeight: FontWeight.bold)),
              const SizedBox(height: 12),
              TextField(
                controller: _email,
                decoration: const InputDecoration(labelText: 'Email'),
                keyboardType: TextInputType.emailAddress,
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _password,
                decoration: const InputDecoration(labelText: 'Password'),
                obscureText: true,
              ),
              if (_error != null)
                Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: _busy ? null : _signIn,
                child: const Text('Sign in'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Home: quick chat + synced notifications + device status
// ---------------------------------------------------------------------------
class WearHomeScreen extends StatefulWidget {
  const WearHomeScreen({super.key, required this.api});
  final MatrixApi api;
  @override
  State<WearHomeScreen> createState() => _WearHomeScreenState();
}

class _WearHomeScreenState extends State<WearHomeScreen> {
  int _tab = 0;
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _tab,
        children: [
          WearChat(api: widget.api),
          WearNotifications(api: widget.api),
          WearDevices(api: widget.api),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        height: 56,
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.chat, size: 19), label: 'Ask'),
          NavigationDestination(icon: Icon(Icons.notifications, size: 19), label: 'Alerts'),
          NavigationDestination(icon: Icon(Icons.devices, size: 19), label: 'Devices'),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Quick chat — asks QORVYNA and shows a SHORT watch-friendly answer (~300 chars).
// ---------------------------------------------------------------------------
class WearChat extends StatefulWidget {
  const WearChat({super.key, required this.api});
  final MatrixApi api;
  @override
  State<WearChat> createState() => _WearChatState();
}

class _WearChatState extends State<WearChat> {
  final _input = TextEditingController();
  String? _answer;
  bool _busy = false;

  Future<void> _ask([String? preset]) async {
    final q = (preset ?? _input.text).trim();
    if (q.isEmpty || _busy) return;
    if (preset == null) _input.clear();
    setState(() {
      _busy = true;
      _answer = null;
    });
    try {
      final res = await widget.api.postJson('/api/ai/compare', {'message': q, 'lanes': ['fast']});
      final results = (res['results'] as List?) ?? [];
      final first = results.isNotEmpty ? (results.first as Map) : null;
      var text = first != null && first['ok'] == true
          ? first['content']?.toString() ?? ''
          : 'Error: ${first?['error'] ?? 'unknown'}';
      if (text.length > 300) text = '${text.substring(0, 300)}…';
      setState(() => _answer = text);
    } on ApiException catch (e) {
      setState(() => _answer = 'Error: ${e.code}');
    } finally {
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('QORVYNA', style: TextStyle(fontSize: 15)), toolbarHeight: 38),
      body: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(
          children: [
            if (_answer != null)
              Expanded(child: SingleChildScrollView(child: Text(_answer!, style: const TextStyle(fontSize: 12.5))))
            else if (_busy)
              const Expanded(child: Center(child: CircularProgressIndicator()))
            else
              Expanded(
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    ActionChip(label: const Text('Summary', style: TextStyle(fontSize: 11)), onPressed: () => _ask('Give me a quick 2-sentence daily check-in.')),
                    ActionChip(label: const Text('Focus tip', style: TextStyle(fontSize: 11)), onPressed: () => _ask('Give one 1-sentence study/work focus tip.')),
                  ],
                ),
              ),
            TextField(
              controller: _input,
              decoration: const InputDecoration(hintText: 'Ask or dictate…', border: OutlineInputBorder()),
              onSubmitted: (_) => _ask(),
            ),
            const SizedBox(height: 6),
            FilledButton(onPressed: _busy ? null : _ask, child: const Text('Ask')),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Synced Notifications glance + one-tap dismiss
// ---------------------------------------------------------------------------
class WearNotifications extends StatefulWidget {
  const WearNotifications({super.key, required this.api});
  final MatrixApi api;
  @override
  State<WearNotifications> createState() => _WearNotificationsState();
}

class _WearNotificationsState extends State<WearNotifications> {
  List<dynamic> _items = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final res = await widget.api.listSyncedNotifications(limit: 12);
      setState(() {
        _items = (res['items'] as List?) ?? [];
        _loading = false;
        _error = null;
      });
    } on ApiException catch (e) {
      setState(() {
        _error = e.code;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Alerts', style: TextStyle(fontSize: 15)),
        toolbarHeight: 38,
        actions: [IconButton(icon: const Icon(Icons.refresh, size: 16), onPressed: _load)],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: const TextStyle(fontSize: 11)))
              : _items.isEmpty
                  ? const Center(child: Text('No alerts', style: TextStyle(fontSize: 12)))
                  : ListView.builder(
                      itemCount: _items.length,
                      itemBuilder: (context, i) {
                        final n = _items[i] as Map;
                        final id = n['id']?.toString() ?? '';
                        return ListTile(
                          dense: true,
                          title: Text('${n['app_name']}: ${n['title']}', style: const TextStyle(fontSize: 12)),
                          subtitle: Text(n['body']?.toString() ?? '', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11)),
                          trailing: IconButton(
                            icon: const Icon(Icons.close, size: 14),
                            onPressed: id.isEmpty
                                ? null
                                : () async {
                                    await widget.api.dismissSyncedNotification(id);
                                    await _load();
                                  },
                          ),
                        );
                      },
                    ),
    );
  }
}

// ---------------------------------------------------------------------------
// Device status — read-only list from the account's device registry.
// ---------------------------------------------------------------------------
class WearDevices extends StatefulWidget {
  const WearDevices({super.key, required this.api});
  final MatrixApi api;
  @override
  State<WearDevices> createState() => _WearDevicesState();
}

class _WearDevicesState extends State<WearDevices> {
  List<dynamic> _devices = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final res = await widget.api.getJson('/api/devices');
      setState(() {
        _devices = (res['devices'] as List?) ?? [];
        _loading = false;
      });
    } on ApiException catch (e) {
      setState(() {
        _error = e.code;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Devices', style: TextStyle(fontSize: 15)), toolbarHeight: 38),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: const TextStyle(fontSize: 12)))
              : ListView.builder(
                  itemCount: _devices.length,
                  itemBuilder: (context, i) {
                    final d = _devices[i] as Map;
                    return ListTile(
                      dense: true,
                      leading: const Icon(Icons.watch, size: 18),
                      title: Text(d['device_name']?.toString() ?? 'Device', style: const TextStyle(fontSize: 13)),
                      subtitle: Text('${d['platform']} · ${d['status'] ?? 'ready'}', style: const TextStyle(fontSize: 11)),
                    );
                  },
                ),
    );
  }
}
