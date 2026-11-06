/// Authenticated API client for the MATRIX backend.
///
/// Native clients authenticate with a Firebase ID token in the
/// `Authorization: Bearer` header — the server verifies it exactly like the
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

  Future<String> _token() async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) throw ApiException('UNAUTHENTICATED', 401);
    // Force refresh so an expired token never produces a confusing 401.
    return user.getIdToken(true);
  }

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
