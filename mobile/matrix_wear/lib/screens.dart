/// Wear OS screens: sign-in (email+password on watch, or rely on the phone
/// companion session), quick chat with short answers, and device status.
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
    setState(() { _busy = true; _error = null; });
    try {
      await FirebaseAuth.instance.signInWithEmailAndPassword(email: _email.text.trim(), password: _password.text);
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
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            const Text('MATRIX', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 12),
            TextField(controller: _email, decoration: const InputDecoration(labelText: 'Email'), keyboardType: TextInputType.emailAddress),
            const SizedBox(height: 8),
            TextField(controller: _password, decoration: const InputDecoration(labelText: 'Password'), obscureText: true),
            if (_error != null) Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
            const SizedBox(height: 12),
            FilledButton(onPressed: _busy ? null : _signIn, child: const Text('Sign in')),
          ]),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Home: quick chat + device status
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
        children: [WearChat(api: widget.api), WearDevices(api: widget.api)],
      ),
      bottomNavigationBar: NavigationBar(
        height: 56,
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.chat, size: 20), label: 'Chat'),
          NavigationDestination(icon: Icon(Icons.devices, size: 20), label: 'Devices'),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Quick chat — asks MATRIX and shows a SHORT answer (first ~300 chars), which
// is the right default on a watch screen.
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

  Future<void> _ask() async {
    final q = _input.text.trim();
    if (q.isEmpty || _busy) return;
    setState(() { _busy = true; _answer = null; });
    try {
      final res = await widget.api.postJson('/api/ai/compare', {'message': q, 'lanes': ['fast']});
      final results = (res['results'] as List?) ?? [];
      final first = results.isNotEmpty ? (results.first as Map) : null;
      var text = first != null && first['ok'] == true ? first['content']?.toString() ?? '' : 'Error: ${first?['error'] ?? 'unknown'}';
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
      appBar: AppBar(title: const Text('MATRIX', style: TextStyle(fontSize: 16)), toolbarHeight: 40),
      body: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(children: [
          if (_answer != null) Expanded(child: SingleChildScrollView(child: Text(_answer!))),
          if (_busy) const Expanded(child: Center(child: CircularProgressIndicator())),
          TextField(controller: _input, decoration: const InputDecoration(hintText: 'Ask…', border: OutlineInputBorder()), onSubmitted: (_) => _ask()),
          const SizedBox(height: 8),
          FilledButton(onPressed: _busy ? null : _ask, child: const Text('Ask')),
        ]),
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
      setState(() { _devices = (res['devices'] as List?) ?? []; _loading = false; });
    } on ApiException catch (e) {
      setState(() { _error = e.code; _loading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Devices', style: TextStyle(fontSize: 16)), toolbarHeight: 40),
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
                      subtitle: Text('${d['platform']}', style: const TextStyle(fontSize: 11)),
                    );
                  },
                ),
    );
  }
}
