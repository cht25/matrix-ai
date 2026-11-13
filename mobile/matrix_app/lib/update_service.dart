// =============================================================================
// MATRIX Phone OTA Update Service (`GET /api/app/version`)
//
// Checks the canonical MATRIX backend (`https://matrix.thamjj13.top/api/app/version`)
// on phone launch, app resume, and manual "Check for updates".
// Supports:
//   1. Optional update bottom sheet with release notes & one-tap APK download
//   2. Mandatory Force Update gate when `force_update` is true or current
//      version is older than `min_supported_version`
// =============================================================================

import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import 'config.dart';

class AppUpdateInfo {
  final String latestVersion;
  final int latestBuild;
  final String minSupportedVersion;
  final bool updateAvailable;
  final bool forceUpdate;
  final String apkUrl;
  final String chatUrl;
  final String sha256;
  final String releaseNotes;

  const AppUpdateInfo({
    required this.latestVersion,
    required this.latestBuild,
    required this.minSupportedVersion,
    required this.updateAvailable,
    required this.forceUpdate,
    required this.apkUrl,
    required this.chatUrl,
    required this.sha256,
    required this.releaseNotes,
  });

  factory AppUpdateInfo.fromJson(Map<String, dynamic> json) {
    return AppUpdateInfo(
      latestVersion: (json['latest_version'] ?? MatrixConfig.appVersion).toString(),
      latestBuild: (json['latest_build'] is num)
          ? (json['latest_build'] as num).toInt()
          : int.tryParse('${json['latest_build'] ?? ''}') ?? MatrixConfig.appBuildNumber,
      minSupportedVersion: (json['min_supported_version'] ?? '1.0.0').toString(),
      updateAvailable: json['update_available'] == true,
      forceUpdate: json['force_update'] == true,
      apkUrl: (json['apk_url'] ?? json['download_url'] ?? '').toString(),
      chatUrl: (json['chat_url'] ?? MatrixConfig.chatUri.toString()).toString(),
      sha256: (json['sha256'] ?? '').toString(),
      releaseNotes: (json['release_notes'] ?? '').toString(),
    );
  }

  String get tag => '$latestVersion+$latestBuild';
}

class UpdateService {
  static const _storage = FlutterSecureStorage();
  static const _dismissedTagKey = 'matrix_dismissed_update_tag';

  static Future<AppUpdateInfo?> checkForUpdate({http.Client? client}) async {
    final c = client ?? http.Client();
    try {
      final uri = MatrixConfig.baseUri.replace(
        path: '/api/app/version',
        queryParameters: {
          'platform': 'android',
          'current_version': MatrixConfig.appVersion,
          'build': '${MatrixConfig.appBuildNumber}',
        },
      );
      final res = await c.get(uri, headers: const {'Accept': 'application/json'}).timeout(
        const Duration(seconds: 10),
      );
      if (res.statusCode != 200) return null;
      final decoded = jsonDecode(res.body);
      if (decoded is! Map) return null;
      return AppUpdateInfo.fromJson(Map<String, dynamic>.from(decoded));
    } catch (_) {
      return null;
    } finally {
      if (client == null) c.close();
    }
  }

  static Future<bool> shouldShowPrompt(AppUpdateInfo info) async {
    if (!info.updateAvailable) return false;
    if (info.forceUpdate) return true;
    try {
      final dismissed = await _storage.read(key: _dismissedTagKey);
      return dismissed != info.tag;
    } catch (_) {
      return true;
    }
  }

  static Future<void> dismissRelease(AppUpdateInfo info) async {
    try {
      await _storage.write(key: _dismissedTagKey, value: info.tag);
    } catch (_) {}
  }

  static Future<bool> openDownload(String url) async {
    final trimmed = url.trim();
    if (trimmed.isEmpty) return false;
    final uri = Uri.tryParse(trimmed);
    if (uri == null) return false;
    return launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  static Future<bool> openWebChat() async {
    return launchUrl(MatrixConfig.chatUri, mode: LaunchMode.externalApplication);
  }

  static Future<void> showUpdateSheet(BuildContext context, AppUpdateInfo info) async {
    await showModalBottomSheet<void>(
      context: context,
      isDismissible: !info.forceUpdate,
      enableDrag: !info.forceUpdate,
      backgroundColor: const Color(0xFF141418),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => PopScope(
        canPop: !info.forceUpdate,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.system_update_rounded, color: Color(0xFF22C55E)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      info.forceUpdate
                          ? 'Required Update · v${info.latestVersion}'
                          : 'MATRIX Update Available · v${info.latestVersion}',
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                'Installed: v${MatrixConfig.appVersion} (build ${MatrixConfig.appBuildNumber}) · Latest build ${info.latestBuild}',
                style: const TextStyle(fontSize: 12, color: Colors.white60),
              ),
              if (info.releaseNotes.isNotEmpty) ...[
                const SizedBox(height: 14),
                Container(
                  width: double.infinity,
                  constraints: const BoxConstraints(maxHeight: 180),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: const Color(0xFF1C1C22),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: SingleChildScrollView(
                    child: Text(
                      info.releaseNotes,
                      style: const TextStyle(fontSize: 13, height: 1.45, color: Colors.white70),
                    ),
                  ),
                ),
              ],
              if (info.sha256.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(
                  'SHA-256: ${info.sha256.substring(0, info.sha256.length > 16 ? 16 : info.sha256.length)}…',
                  style: const TextStyle(fontSize: 11, fontFamily: 'monospace', color: Colors.white38),
                ),
              ],
              const SizedBox(height: 18),
              Row(
                children: [
                  if (!info.forceUpdate) ...[
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () async {
                          await dismissRelease(info);
                          if (ctx.mounted) Navigator.of(ctx).pop();
                        },
                        child: const Text('Later'),
                      ),
                    ),
                    const SizedBox(width: 10),
                  ],
                  Expanded(
                    flex: 2,
                    child: FilledButton.icon(
                      onPressed: () async {
                        await openDownload(info.apkUrl);
                      },
                      icon: const Icon(Icons.download_rounded, size: 18),
                      label: const Text('Download & Update APK'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
