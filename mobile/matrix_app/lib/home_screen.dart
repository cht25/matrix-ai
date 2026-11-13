import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'agent_screen.dart';
import 'automations_screen.dart';
import 'chat_screen.dart';
import 'config.dart';
import 'devices_screen.dart';
import 'family_screen.dart';
import 'update_service.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  int _index = 0;
  AppUpdateInfo? _forcedUpdate;
  bool _checkingUpdate = false;

  static const _tabs = <({String label, IconData icon, Widget page})>[
    (label: 'Chat', icon: Icons.chat_bubble_outline, page: ChatScreen()),
    (label: 'Agent', icon: Icons.terminal, page: AgentScreen()),
    (label: 'Automations', icon: Icons.schedule, page: AutomationsScreen()),
    (label: 'Devices', icon: Icons.devices_other, page: DevicesScreen()),
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _runUpdateCheck(manual: false));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _runUpdateCheck(manual: false);
    }
  }

  Future<void> _runUpdateCheck({required bool manual}) async {
    if (_checkingUpdate) return;
    _checkingUpdate = true;
    try {
      final info = await UpdateService.checkForUpdate();
      if (!mounted) return;
      if (info == null) {
        if (manual) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Could not reach update server.')),
          );
        }
        return;
      }
      if (info.forceUpdate && info.updateAvailable) {
        setState(() => _forcedUpdate = info);
        await UpdateService.showUpdateSheet(context, info);
        return;
      }
      setState(() => _forcedUpdate = null);
      if (info.updateAvailable && (manual || await UpdateService.shouldShowPrompt(info))) {
        await UpdateService.showUpdateSheet(context, info);
      } else if (manual) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('MATRIX v${MatrixConfig.appVersion} is up to date.')),
        );
      }
    } finally {
      _checkingUpdate = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_forcedUpdate != null) {
      return Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.system_update_rounded, size: 48, color: Color(0xFF22C55E)),
                const SizedBox(height: 14),
                Text(
                  'Update Required · v${_forcedUpdate!.latestVersion}',
                  style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 8),
                Text(
                  _forcedUpdate!.releaseNotes.isNotEmpty
                      ? _forcedUpdate!.releaseNotes
                      : 'Please install the latest MATRIX Android release to continue.',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white70, height: 1.45),
                ),
                const SizedBox(height: 20),
                FilledButton.icon(
                  onPressed: () => UpdateService.openDownload(_forcedUpdate!.apkUrl),
                  icon: const Icon(Icons.download_rounded),
                  label: const Text('Download Latest APK'),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final user = FirebaseAuth.instance.currentUser;
    return Scaffold(
      appBar: AppBar(
        title: Text(_tabs[_index].label),
      ),
      drawer: Drawer(
        backgroundColor: const Color(0xFF101013),
        child: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Text('MATRIX AI', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: const Color(0xFF143524),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: const Text(
                            'v${MatrixConfig.appVersion}',
                            style: TextStyle(fontSize: 10.5, color: Color(0xFF4ADE80)),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(user?.email ?? '', style: const TextStyle(color: Colors.white60, fontSize: 12)),
                  ],
                ),
              ),
              const Divider(height: 1, color: Colors.white10),
              ListTile(
                leading: const Icon(Icons.family_restroom_outlined),
                title: const Text('Family'),
                onTap: () {
                  Navigator.of(context).pop();
                  Navigator.of(context).push(MaterialPageRoute(builder: (_) => const FamilyScreen()));
                },
              ),
              ListTile(
                leading: const Icon(Icons.open_in_browser_rounded),
                title: const Text('Open Web Workspace'),
                subtitle: const Text('matrix.thamjj13.top/chat', style: TextStyle(fontSize: 11, color: Colors.white54)),
                onTap: () {
                  Navigator.of(context).pop();
                  UpdateService.openWebChat();
                },
              ),
              ListTile(
                leading: const Icon(Icons.system_update_outlined),
                title: const Text('Check for phone updates'),
                onTap: () {
                  Navigator.of(context).pop();
                  _runUpdateCheck(manual: true);
                },
              ),
              const Spacer(),
              const Divider(height: 1, color: Colors.white10),
              ListTile(
                leading: const Icon(Icons.logout, color: Color(0xFFF87171)),
                title: const Text('Sign out', style: TextStyle(color: Color(0xFFF87171))),
                onTap: () async {
                  Navigator.of(context).pop();
                  await FirebaseAuth.instance.signOut();
                },
              ),
            ],
          ),
        ),
      ),
      body: IndexedStack(index: _index, children: [for (final t in _tabs) t.page]),
      bottomNavigationBar: NavigationBar(
        backgroundColor: const Color(0xFF101013),
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: [
          for (final t in _tabs) NavigationDestination(icon: Icon(t.icon), label: t.label),
        ],
      ),
    );
  }
}
