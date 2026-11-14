// Unit tests for MATRIX Phone App API client, canonical URLs, and OTA UpdateService.
// Run with: flutter test
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:matrix_app/api.dart';
import 'package:matrix_app/config.dart';
import 'package:matrix_app/update_service.dart';

void main() {
  test('MatrixConfig points to canonical https://matrix.thamjj13.top and /chat', () {
    expect(MatrixConfig.apiBase, 'https://matrix.thamjj13.top');
    expect(MatrixConfig.chatUri.toString(), 'https://matrix.thamjj13.top/chat');
    expect(MatrixConfig.appVersion, '1.1.0');
    expect(MatrixConfig.appBuildNumber, 2);
  });

  test('ApiException exposes code and status', () {
    final e = ApiException('VERCEL_NOT_CONFIGURED', 503);
    expect(e.code, 'VERCEL_NOT_CONFIGURED');
    expect(e.status, 503);
    expect(e.toString(), 'VERCEL_NOT_CONFIGURED');
  });

  test('UpdateService.checkForUpdate parses OTA phone release payload', () async {
    final client = MockClient((request) async {
      expect(request.url.path, '/api/app/version');
      expect(request.url.queryParameters['platform'], 'android');
      return http.Response(
        jsonEncode({
          'ok': true,
          'latest_version': '1.2.0',
          'latest_build': 3,
          'min_supported_version': '1.1.0',
          'update_available': true,
          'force_update': false,
          'apk_url': 'https://github.com/cht25/matrix-ai/releases/latest/download/matrix-android.apk',
          'chat_url': 'https://matrix.thamjj13.top/chat',
          'release_notes': 'OTA update',
        }),
        200,
      );
    });

    final info = await UpdateService.checkForUpdate(client: client);
    expect(info, isNotNull);
    expect(info!.latestVersion, '1.2.0');
    expect(info.latestBuild, 3);
    expect(info.updateAvailable, isTrue);
    expect(info.forceUpdate, isFalse);
    expect(info.chatUrl, 'https://matrix.thamjj13.top/chat');
    client.close();
  });
}
