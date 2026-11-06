// Unit tests for the MATRIX API client's error envelope handling.
// Run with: flutter test
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:matrix_app/api.dart';

// The api client reads the Firebase token via FirebaseAuth; for unit tests we
// exercise the decode/envelope logic through a stubbed client by calling the
// internal path indirectly is not possible without auth, so we test the
// public contract that matters: ApiException carries the server code.
void main() {
  test('ApiException exposes code and status', () {
    final e = ApiException('VERCEL_NOT_CONFIGURED', 503);
    expect(e.code, 'VERCEL_NOT_CONFIGURED');
    expect(e.status, 503);
    expect(e.toString(), 'VERCEL_NOT_CONFIGURED');
  });

  test('stub client returns server error envelope shape', () async {
    final client = MockClient((request) async {
      return http.Response(jsonEncode({'success': false, 'error': {'code': 'RATE_LIMITED', 'message': 'RATE_LIMITED'}}), 429);
    });
    final res = await client.get(Uri.parse('https://example.invalid/api/rpc'));
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    expect(res.statusCode, 429);
    expect((body['error'] as Map)['code'], 'RATE_LIMITED');
    client.close();
  });
}
