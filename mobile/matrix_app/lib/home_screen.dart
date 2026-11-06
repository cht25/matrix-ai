/// Home: bottom navigation — Chat, Pair device (QR), Devices, Sign out.
/// Mirrors the web workspace but only requests what each feature needs.
library;

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

  @override
  Widget build(BuildContext context) {
    final pages = [
      ChatScreen(api: widget.api),
      PairingScreen(api: widget.api),
      DevicesScreen(api: widget.api),
    ];
    return Scaffold(
      body: pages[_index],
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
              onTap: () => FirebaseAuth.instance.signOut(),
            ),
          ],
        ),
      ),
    );
  }
}
