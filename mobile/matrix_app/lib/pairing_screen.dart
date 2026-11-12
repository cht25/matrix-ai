/// MATRIX Connect — QR pairing screen.
///
/// Supports BOTH:
///   1. Cross-account Family QR (`matrix-family-pair:v1.<token>` or `...#pair=<token>`)
///      so family members use their OWN accounts without logging into the same account.
///   2. Own-account QR (`matrix-pairing:v1.…`) for a second personal device.
library;

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'api.dart';

class PairingScreen extends StatefulWidget {
  const PairingScreen({super.key, required this.api});
  final MatrixApi api;
  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  bool _busy = false;
  String? _message;
  bool _done = false;
  final _controller = MobileScannerController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  String? _extractFamilyToken(String raw) {
    if (raw.startsWith('matrix-family-pair:v1.')) {
      return raw.substring('matrix-family-pair:v1.'.length).trim();
    }
    final match = RegExp(r'[?&#]pair=([A-Za-z0-9_-]+)').firstMatch(raw);
    return match?.group(1);
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_busy || _done) return;
    final raw = capture.barcodes.isNotEmpty ? capture.barcodes.first.rawValue : null;
    if (raw == null) return;

    final familyToken = _extractFamilyToken(raw);
    final isOwnAccount = raw.startsWith('matrix-pairing:v1.');
    if (familyToken == null && !isOwnAccount) return;

    setState(() {
      _busy = true;
      _message = null;
    });
    await _controller.stop();
    try {
      final deviceName = 'Android phone (${DateTime.now().toIso8601String().substring(0, 10)})';
      if (familyToken != null) {
        await widget.api.pairFamilyDevice(
          pairToken: familyToken,
          deviceName: deviceName,
        );
        setState(() {
          _done = true;
          _message = 'Linked to your MATRIX Family (cross-account)!';
        });
      } else {
        final res = await widget.api.pairDevice({
          'qr_payload': raw,
          'device_name': deviceName,
          'device_type': 'phone',
          'platform': 'android',
        });
        setState(() {
          _done = true;
          _message = 'Linked: ${(res['device'] as Map?)?['device_name'] ?? 'device'}';
        });
      }
    } on ApiException catch (e) {
      setState(() => _message = 'Pairing failed: ${e.code.replaceAll('_', ' ').toLowerCase()}');
      await _controller.start();
    } finally {
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Pair this device')),
      body: Column(
        children: [
          Expanded(
            child: _done
                ? Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.check_circle, color: Colors.green, size: 56),
                        const SizedBox(height: 12),
                        Text(_message ?? 'Paired', textAlign: TextAlign.center),
                      ],
                    ),
                  )
                : MobileScanner(controller: _controller, onDetect: _onDetect),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(
              _message ??
                  'Scan either a Cross-Account Family QR (sign in with your own account) or an Own-Account QR from MATRIX → Devices.',
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.grey),
            ),
          ),
        ],
      ),
    );
  }
}
