/// Authenticated API client for the MATRIX backend.
///
/// Pairing uses a Firebase ID token; subsequent requests use the
/// revocable device credential in `Authorization: Bearer` — the server verifies it exactly like the
/// web session cookie (see src/lib/firebase/session.ts). Tokens are kept in
/// FlutterSecureStorage and never logged.
library;

import 'dart:convert';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'config.dart';

class ApiException implements Exception {
  final String code;
  final int status;
  ApiException(this.code, this.status);
  @override
  String toString() => code;
}

class MatrixApi {
  MatrixApi({http.Client? client}) : _client = client ?? http.Client();
  final http.Client _client;
  static const _storage = FlutterSecureStorage();

  Future<String> _accountToken() async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) throw ApiException('UNAUTHENTICATED', 401);
    return user.getIdToken(true);
  }

  Future<String> _token() async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) throw ApiException('UNAUTHENTICATED', 401);
    final stored = await _storage.read(key: 'matrix_device_credential');
    if (stored == null || stored.isEmpty) return _accountToken();
    final credential = jsonDecode(stored) as Map<String, dynamic>;
    if (credential['owner_uid'] != user.uid) {
      throw ApiException('PAIRING_ACCOUNT_MISMATCH', 403);
    }
    final expiry = DateTime.tryParse(credential['expires_at']?.toString() ?? '');
    if (expiry == null || !expiry.isAfter(DateTime.now().toUtc())) {
      throw ApiException('DEVICE_CREDENTIAL_EXPIRED', 401);
    }
    final token = credential['access_token']?.toString() ?? '';
    if (!token.startsWith('matrix_device.')) throw ApiException('DEVICE_CREDENTIAL_INVALID', 401);
    // A revoked credential must never silently fall back to account auth.
    return token;
  }

  Future<Map<String, dynamic>> pairDevice(Map<String, dynamic> payload) async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) throw ApiException('UNAUTHENTICATED', 401);
    final token = await _accountToken();
    final response = await _sendRaw('POST', MatrixConfig.baseUri.resolve('/api/devices/pairing/complete'), token, payload);
    final data = _decode(response);
    if (response.statusCode != 200 || data['access_token'] == null) {
      throw ApiException(data['error']?.toString() ?? 'PAIRING_FAILED', response.statusCode);
    }
    await _storage.write(key: 'matrix_device_credential', value: jsonEncode({
      'access_token': data['access_token'],
      'expires_at': data['access_token_expires_at'],
      'owner_uid': user.uid,
      'device_id': (data['device'] as Map?)?['id'],
    }));
    return data;
  }

  /// Cross-account Family pairing (`matrix-family-pair:v1.<token>`).
  /// Signs in with the member's OWN Firebase account — no shared login needed.
  Future<Map<String, dynamic>> pairFamilyDevice({
    required String pairToken,
    required String deviceName,
    String deviceType = 'phone',
    String platform = 'android',
  }) async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) throw ApiException('UNAUTHENTICATED', 401);
    final accountJwt = await _accountToken();
    final response = await _sendRaw(
      'POST',
      MatrixConfig.baseUri.resolve('/api/rpc'),
      accountJwt,
      {
        'action': 'family_pairing_complete',
        'pair_token': pairToken,
        'device_name': deviceName,
        'device_type': deviceType,
        'platform': platform,
      },
    );
    final envelope = _decode(response);
    if (response.statusCode != 200 || envelope['success'] != true) {
      final err = envelope['error'];
      final code = err is String ? err : (err is Map ? (err['code'] ?? 'PAIRING_FAILED') : 'PAIRING_FAILED');
      throw ApiException(code.toString(), response.statusCode);
    }
    final data = Map<String, dynamic>.from(envelope['data'] as Map? ?? {});
    if (data['access_token'] != null) {
      await _storage.write(key: 'matrix_device_credential', value: jsonEncode({
        'access_token': data['access_token'],
        'expires_at': data['access_token_expires_at'],
        'owner_uid': user.uid,
        'device_id': data['device_id'],
        'family_id': data['family_id'],
      }));
    }
    return data;
  }

  /// Sync own + family opt-in app usage, hidden apps, and browser history.
  Future<Map<String, dynamic>> reportDeviceActivity({
    required int screenTimeMinutes,
    required List<Map<String, dynamic>> apps,
    required List<Map<String, dynamic>> hiddenApps,
    required List<Map<String, dynamic>> browserHistory,
    String? deviceName,
  }) async {
    final deviceId = await currentDeviceId();
    return rpc('device_activity_report', {
      if (deviceId != null) 'device_id': deviceId,
      if (deviceName != null) 'device_name': deviceName,
      'platform': 'android',
      'screen_time_minutes': screenTimeMinutes,
      'apps': apps,
      'hidden_apps': hiddenApps,
      'browser_history': browserHistory,
    });
  }

  /// Poll active family screen-mirror sessions and Google Family Link lock state.
  Future<Map<String, dynamic>> activeMirrorAndLock() => rpc('family_mirror_active');

  /// Child one-tap disable of screen mirroring (requires parent re-grant to resume).
  Future<Map<String, dynamic>> disableFamilyMirroring(String familyId) =>
      rpc('family_mirror_consent', {'family_id': familyId, 'consent': 'revoke'});

  static Future<String?> currentDeviceId() async {
    final raw = await _storage.read(key: 'matrix_device_credential');
    if (raw == null || raw.isEmpty) return null;
    return (jsonDecode(raw) as Map)['device_id']?.toString();
  }

  static Future<void> clearDeviceCredential() => _storage.delete(key: 'matrix_device_credential');

  Future<String?> accountLabel() async => FirebaseAuth.instance.currentUser?.email;

  Map<String, String> _headers(String token) => {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      };

  Future<http.Response> _send(String method, String path, [Object? body]) async {
    final token = await _token();
    final uri = MatrixConfig.baseUri.resolve(path);
    final res = await _sendRaw(method, uri, token, body);
    return res;
  }

  Future<http.Response> _sendRaw(String method, Uri uri, String token, Object? body) {
    switch (method) {
      case 'GET':
        return _client.get(uri, headers: _headers(token));
      case 'DELETE':
        return _client.delete(uri, headers: _headers(token));
      case 'POST':
        return _client.post(uri, headers: _headers(token), body: body != null ? jsonEncode(body) : null);
      default:
        return _client.patch(uri, headers: _headers(token), body: body != null ? jsonEncode(body) : null);
    }
  }

  /// Throws ApiException with the server's stable error code.
  Future<Map<String, dynamic>> rpc(String action, [Map<String, dynamic> args = const {}]) async {
    final res = await _send('POST', '/api/rpc', {'action': action, ...args});
    final data = _decode(res);
    if (res.statusCode != 200 || data['success'] != true) {
      final err = data['error'];
      final code = err is String ? err : (err is Map ? (err['code'] ?? 'HTTP_${res.statusCode}') : 'HTTP_${res.statusCode}');
      throw ApiException(code.toString(), res.statusCode);
    }
    return Map<String, dynamic>.from(data['data'] as Map? ?? {'ok': true});
  }

  Future<Map<String, dynamic>> getJson(String path) async {
    final res = await _send('GET', path);
    final data = _decode(res);
    if (res.statusCode != 200) {
      throw ApiException(data['error']?.toString() ?? 'HTTP_${res.statusCode}', res.statusCode);
    }
    return data;
  }

  Future<Map<String, dynamic>> postJson(String path, [Object? body]) async {
    final res = await _send('POST', path, body);
    final data = _decode(res);
    if (res.statusCode >= 400) {
      throw ApiException(data['error']?.toString() ?? 'HTTP_${res.statusCode}', res.statusCode);
    }
    return data;
  }

  Future<void> deleteJson(String path) async {
    final res = await _send('DELETE', path);
    if (res.statusCode >= 400) {
      final data = _decode(res);
      throw ApiException(data['error']?.toString() ?? 'HTTP_${res.statusCode}', res.statusCode);
    }
  }

  Map<String, dynamic> _decode(http.Response res) {
    try {
      return Map<String, dynamic>.from(jsonDecode(res.body) as Map? ?? {});
    } catch (_) {
      return {'error': 'HTTP_${res.statusCode}'};
    }
  }

  /// Keep a cached copy of the last token for diagnostics (never the raw token
  /// is logged; storage is platform-encrypted).
  static Future<void> rememberSignedIn() => _storage.write(key: 'matrix_signed_in', value: '1');
}
