/// Register this phone as a Child device.
///
///   1. Scan the Parent's QR (`matrix-pairing:v1.…`) or type its pairing code.
///   2. The request is sent; nothing is shared yet.
///   3. Wait for the Parent to approve. On approval this phone receives its
///      own revocable credential, stored in the Android Keystore-backed
///      secure storage.
///
/// A Family invitation QR (`matrix-family-pair:v1.<token>`) is also accepted
/// and handled by the separate Family flow.
library;

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'api.dart';

enum _Phase { scanning, sending, waiting, connected, failed }

class PairingScreen extends StatefulWidget {
  const PairingScreen({super.key, required this.api});
  final MatrixApi api;
  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  final _controller = MobileScannerController();
  final _code = TextEditingController();
  _Phase _phase = _Phase.scanning;
  String? _message;
  String? _parentName;
  String? _challengeId;
  String? _claimSecret;
  Timer? _poll;
  bool _polling = false;
  bool _torchOn = false;

  @override
  void dispose() {
    _poll?.cancel();
    _controller.dispose();
    _code.dispose();
    super.dispose();
  }

  static String _explain(String code) {
    switch (code) {
      case 'PAIRING_EXPIRED':
        return 'That code has expired. Ask the Parent device for a new one.';
      case 'PAIRING_USED':
        return 'That code was already used. Ask the Parent device for a new one.';
      case 'PAIRING_INVALID':
        return 'That is not a valid MATRIX pairing code.';
      case 'PAIRING_ACCOUNT_MISMATCH':
        return 'That code belongs to a different MATRIX account. Sign in to the same account on both devices.';
      case 'PAIRING_RATE_LIMITED':
        return 'Too many attempts. Wait a few minutes and try again.';
      case 'UNAUTHENTICATED':
        return 'Your session expired. Sign in again.';
      default:
        return 'The request could not be sent. Check your connection and try again.';
    }
  }

  String get _deviceName => 'Android phone';

  String? _familyToken(String raw) {
    if (raw.startsWith('matrix-family-pair:v1.')) {
      return raw.substring('matrix-family-pair:v1.'.length).trim();
    }
    final match = RegExp(r'[?&#]pair=([A-Za-z0-9_-]+)').firstMatch(raw);
    return match?.group(1);
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_phase != _Phase.scanning) return;
    final raw = capture.barcodes.isNotEmpty ? capture.barcodes.first.rawValue : null;
    if (raw == null) return;
    final family = _familyToken(raw);
    if (family != null) {
      await _linkFamily(family);
      return;
    }
    if (!raw.startsWith('matrix-pairing:v1.')) {
      setState(() => _message = 'That QR code is not a MATRIX pairing code.');
      return;
    }
    await _request(qrPayload: raw);
  }

  Future<void> _linkFamily(String token) async {
    setState(() {
      _phase = _Phase.sending;
      _message = null;
    });
    await _controller.stop();
    try {
      await widget.api.pairFamilyDevice(pairToken: token, deviceName: _deviceName);
      if (!mounted) return;
      setState(() {
        _phase = _Phase.connected;
        _message = 'This phone is linked to your MATRIX Family.';
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.scanning;
        _message = _explain(e.code);
      });
      await _controller.start();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.scanning;
        _message = _explain('NETWORK');
      });
      await _controller.start();
    }
  }

  Future<void> _request({String? qrPayload, String? manualCode}) async {
    setState(() {
      _phase = _Phase.sending;
      _message = null;
    });
    await _controller.stop();
    try {
      final res = await widget.api.requestPairing(qrPayload: qrPayload, manualCode: manualCode, deviceName: _deviceName);
      _challengeId = res['challenge_id']?.toString();
      _claimSecret = res['claim_secret']?.toString();
      if (_challengeId == null || _claimSecret == null) throw ApiException('PAIRING_INVALID', 400);
      if (!mounted) return;
      setState(() => _phase = _Phase.waiting);
      _poll?.cancel();
      _poll = Timer.periodic(const Duration(seconds: 3), (_) => _checkDecision());
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.scanning;
        _message = _explain(e.code);
      });
      await _controller.start();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.scanning;
        _message = _explain('NETWORK');
      });
      await _controller.start();
    }
  }

  Future<void> _checkDecision() async {
    if (_polling || _phase != _Phase.waiting || _challengeId == null || _claimSecret == null) return;
    _polling = true;
    try {
      final res = await widget.api.claimPairing(challengeId: _challengeId!, claimSecret: _claimSecret!);
      if (!mounted) return;
      final status = res['status']?.toString();
      if (status == 'approved') {
        _poll?.cancel();
        setState(() {
          _phase = _Phase.connected;
          _parentName = (res['parent'] as Map?)?['device_name']?.toString();
          _message = null;
        });
      } else if (status == 'denied' || status == 'expired') {
        _poll?.cancel();
        setState(() {
          _phase = _Phase.failed;
          _message = status == 'denied'
              ? 'The Parent device declined this request.'
              : 'The request expired before it was approved.';
        });
      }
    } on ApiException catch (e) {
      // A temporary server or network problem: keep waiting. Anything else ends the attempt.
      if (e.status < 500 && e.status != 429 && mounted) {
        _poll?.cancel();
        setState(() {
          _phase = _Phase.failed;
          _message = _explain(e.code);
        });
      }
    } catch (_) {
      // Offline for a moment: the next tick tries again.
    } finally {
      _polling = false;
    }
  }

  Future<void> _restart() async {
    _poll?.cancel();
    _challengeId = null;
    _claimSecret = null;
    setState(() {
      _phase = _Phase.scanning;
      _message = null;
    });
    await _controller.start();
  }

  Future<void> _toggleTorch() async {
    try {
      await _controller.toggleTorch();
      if (mounted) setState(() => _torchOn = !_torchOn);
    } catch (_) {
      if (mounted) setState(() => _message = 'This camera has no light.');
    }
  }

  Future<void> _switchCamera() async {
    try {
      await _controller.switchCamera();
      if (mounted) setState(() => _torchOn = false);
    } catch (_) {
      if (mounted) setState(() => _message = 'No other camera is available.');
    }
  }

  Widget _cameraProblem(MobileScannerException error) {
    final denied = error.errorCode == MobileScannerErrorCode.permissionDenied;
    return Container(
      color: Colors.black,
      alignment: Alignment.center,
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.no_photography_outlined, size: 40, color: Colors.white70),
          const SizedBox(height: 12),
          Text(
            denied
                ? 'Camera access is off. Allow the camera for MATRIX in Android settings, or type the pairing code below.'
                : 'The camera could not be started. Type the pairing code below instead.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white70),
          ),
        ],
      ),
    );
  }

  Widget _scanner() {
    final sending = _phase == _Phase.sending;
    final normalized = _code.text.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        AspectRatio(
          aspectRatio: 1,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: Stack(
              fit: StackFit.expand,
              children: [
                MobileScanner(
                  controller: _controller,
                  onDetect: _onDetect,
                  errorBuilder: (context, error, child) => _cameraProblem(error),
                ),
                if (sending) Container(color: Colors.black54, alignment: Alignment.center, child: const CircularProgressIndicator()),
              ],
            ),
          ),
        ),
        const SizedBox(height: 8),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            TextButton.icon(onPressed: sending ? null : _toggleTorch, icon: Icon(_torchOn ? Icons.flashlight_off : Icons.flashlight_on), label: Text(_torchOn ? 'Light off' : 'Light on')),
            const SizedBox(width: 8),
            TextButton.icon(onPressed: sending ? null : _switchCamera, icon: const Icon(Icons.cameraswitch_outlined), label: const Text('Switch camera')),
          ],
        ),
        if (_message != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(_message!, textAlign: TextAlign.center, style: const TextStyle(color: Color(0xFFFCA5A5))),
          ),
        const SizedBox(height: 12),
        const Text('Or type the pairing code', style: TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        TextField(
          controller: _code,
          enabled: !sending,
          textCapitalization: TextCapitalization.characters,
          autocorrect: false,
          decoration: const InputDecoration(labelText: 'Pairing code', hintText: 'ABCD-2345', border: OutlineInputBorder()),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 8),
        FilledButton(
          onPressed: sending || normalized.length != 8 ? null : () => _request(manualCode: normalized),
          child: const Text('Request to join'),
        ),
        const SizedBox(height: 12),
        const Text(
          'Both devices must be signed in to the same MATRIX account. Nothing is shared until the Parent approves.',
          textAlign: TextAlign.center,
          style: TextStyle(color: Colors.white54, fontSize: 12),
        ),
      ],
    );
  }

  Widget _status({required IconData icon, required Color color, required String title, required String body, required List<Widget> actions, bool busy = false}) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (busy) const CircularProgressIndicator() else Icon(icon, color: color, size: 56),
            const SizedBox(height: 16),
            Text(title, textAlign: TextAlign.center, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Text(body, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70)),
            const SizedBox(height: 16),
            ...actions,
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    Widget body;
    switch (_phase) {
      case _Phase.scanning:
      case _Phase.sending:
        body = _scanner();
      case _Phase.waiting:
        body = _status(
          icon: Icons.hourglass_top,
          color: Colors.white70,
          busy: true,
          title: 'Waiting for the Parent to approve',
          body: 'Open MATRIX on the Parent device and approve "$_deviceName".',
          actions: [TextButton(onPressed: _restart, child: const Text('Cancel'))],
        );
      case _Phase.connected:
        body = _status(
          icon: Icons.check_circle,
          color: Colors.green,
          title: 'Connected',
          body: _message ?? (_parentName != null ? 'This phone is connected to $_parentName.' : 'This phone is registered.'),
          actions: [FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Done'))],
        );
      case _Phase.failed:
        body = _status(
          icon: Icons.error_outline,
          color: const Color(0xFFF87171),
          title: 'Not connected',
          body: _message ?? 'The request did not complete.',
          actions: [FilledButton(onPressed: _restart, child: const Text('Scan again'))],
        );
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Register as Child')),
      body: SafeArea(child: body),
    );
  }
}
