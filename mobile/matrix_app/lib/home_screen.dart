/// Home: bottom navigation — Chat, Pair device (QR), Devices, Sign out — plus
/// transparent Family Screen Mirroring indicator & Google Family Link lock shield.
library;

import 'dart:async';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'api.dart';
import 'chat_screen.dart';
import 'devices_screen.dart';
import 'pairing_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.api});
  final MatrixApi api;
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _index = 0;
  Timer? _pollTimer;
  List<dynamic> _activeMirrorSessions = const [];
  Map<String, dynamic>? _locked;

  @override
  void initState() {
    super.initState();
    _pollSupervision();
    _pollTimer = Timer.periodic(const Duration(seconds: 8), (_) => _pollSupervision());
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _pollSupervision() async {
    try {
      final res = await widget.api.activeMirrorAndLock();
      if (!mounted) return;
      setState(() {
        _activeMirrorSessions = (res['active_sessions'] as List?) ?? const [];
        _locked = res['locked'] is Map ? Map<String, dynamic>.from(res['locked'] as Map) : null;
      });
    } catch (_) {
      // Transient offline / unlinked state.
    }
  }

  Future<void> _disableMirror(String familyId) async {
    try {
      await widget.api.disableFamilyMirroring(familyId);
      await _pollSupervision();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Screen mirroring disabled. A parent must re-grant access to turn it back on.')),
        );
      }
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    if (_locked != null) {
      final familyName = _locked!['family_name']?.toString() ?? 'Family';
      final reason = _locked!['reason']?.toString() ?? 'Paused by a parent in your family';
      final familyId = _locked!['family_id']?.toString() ?? '';
      return Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.lock_clock, size: 64, color: Colors.amber),
                const SizedBox(height: 16),
                Text('$familyName · Family Supervision', style: const TextStyle(color: Colors.amber, fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                const Text('Time for a break', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                const SizedBox(height: 8),
                Text(reason, textAlign: TextAlign.center),
                const SizedBox(height: 20),
                FilledButton(
                  onPressed: familyId.isEmpty
                      ? null
                      : () async {
                          await widget.api.rpc('family_request_parent_access', {'family_id': familyId, 'kind': 'unlock_device'});
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Unlock request sent to your parent.')));
                          }
                        },
                  child: const Text('Ask parent to unlock'),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final pages = [
      ChatScreen(api: widget.api),
      PairingScreen(api: widget.api),
      DevicesScreen(api: widget.api),
    ];
    final activeMirror = _activeMirrorSessions.isNotEmpty ? _activeMirrorSessions.first as Map : null;

    return Scaffold(
      body: Column(
        children: [
          if (activeMirror != null)
            Material(
              color: Colors.amber.shade900,
              child: SafeArea(
                bottom: false,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  child: Row(
                    children: [
                      const Icon(Icons.visibility, color: Colors.white, size: 18),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'Family screen mirroring active: ${activeMirror['viewer_name'] ?? 'Parent'} (${activeMirror['family_name'] ?? 'Family'}) is viewing.',
                          style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600),
                        ),
                      ),
                      TextButton(
                        onPressed: () => _disableMirror(activeMirror['family_id']?.toString() ?? ''),
                        child: const Text('Disable', style: TextStyle(color: Colors.white)),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          Expanded(child: pages[_index]),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.chat_bubble_outline), label: 'Chat'),
          NavigationDestination(icon: Icon(Icons.qr_code_scanner), label: 'Pair device'),
          NavigationDestination(icon: Icon(Icons.devices), label: 'Devices'),
        ],
      ),
      drawer: Drawer(
        child: ListView(
          children: [
            DrawerHeader(child: Text(FirebaseAuth.instance.currentUser?.email ?? 'MATRIX')),
            ListTile(
              leading: const Icon(Icons.logout),
              title: const Text('Sign out'),
              onTap: () async {
                await MatrixApi.clearDeviceCredential();
                await FirebaseAuth.instance.signOut();
              },
            ),
          ],
        ),
      ),
    );
  }
}
