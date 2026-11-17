/// Native Android platform bridge (SpeechRecognizer, TextToSpeech, Notification
/// Listener Service, MediaProjection screen capture, Digital Assistant intent,
/// installed app launching, media keys, and battery/OS status).
library;

import 'dart:async';
import 'package:flutter/services.dart';

class NativeBridge {
  NativeBridge._();
  static final NativeBridge instance = NativeBridge._();

  static const _method = MethodChannel('top.thamjj13.matrix/native');
  static const _event = EventChannel('top.thamjj13.matrix/native_events');

  Stream<Map<String, dynamic>>? _broadcast;

  Stream<Map<String, dynamic>> get events {
    _broadcast ??= _event.receiveBroadcastStream().map((raw) {
      if (raw is Map) {
        return Map<String, dynamic>.from(raw);
      }
      return <String, dynamic>{'type': 'unknown', 'data': <String, dynamic>{}};
    }).asBroadcastStream();
    return _broadcast!;
  }

  Future<bool> consumeInitialAssistLaunch() async {
    try {
      return await _method.invokeMethod<bool>('consumeInitialAssistLaunch') ?? false;
    } catch (_) {
      return false;
    }
  }

  Future<Map<String, dynamic>> getDeviceStatus() async {
    try {
      final raw = await _method.invokeMethod<Map>('getDeviceStatus');
      return raw != null ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  Future<bool> isNotificationAccessEnabled() async {
    try {
      return await _method.invokeMethod<bool>('isNotificationAccessEnabled') ?? false;
    } catch (_) {
      return false;
    }
  }

  Future<void> openNotificationAccessSettings() async {
    try {
      await _method.invokeMethod('openNotificationAccessSettings');
    } catch (_) {}
  }

  Future<void> openAssistantSettings() async {
    try {
      await _method.invokeMethod('openAssistantSettings');
    } catch (_) {}
  }

  Future<List<Map<String, dynamic>>> listActiveNotifications() async {
    try {
      final raw = await _method.invokeMethod<List>('listActiveNotifications') ?? const [];
      return raw.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
    } catch (_) {
      return const [];
    }
  }

  Future<bool> dismissSystemNotification(String key) async {
    try {
      return await _method.invokeMethod<bool>('dismissSystemNotification', {'key': key}) ?? false;
    } catch (_) {
      return false;
    }
  }

  Future<Map<String, dynamic>> openInstalledApp(String appName) async {
    try {
      final raw = await _method.invokeMethod<Map>('openInstalledApp', {'app_name': appName});
      return raw != null ? Map<String, dynamic>.from(raw) : {'ok': false, 'status': 'failed'};
    } catch (e) {
      return {'ok': false, 'status': 'failed', 'message': e.toString()};
    }
  }

  Future<Map<String, dynamic>> mediaControl(String action) async {
    try {
      final raw = await _method.invokeMethod<Map>('mediaControl', {'action': action});
      return raw != null ? Map<String, dynamic>.from(raw) : {'ok': false, 'status': 'failed'};
    } catch (e) {
      return {'ok': false, 'status': 'failed', 'message': e.toString()};
    }
  }

  Future<bool> speakText(String text, {String language = 'en-US', double rate = 1.0}) async {
    try {
      return await _method.invokeMethod<bool>('speakText', {
            'text': text,
            'language': language,
            'rate': rate,
          }) ??
          false;
    } catch (_) {
      return false;
    }
  }

  Future<void> stopSpeaking() async {
    try {
      await _method.invokeMethod('stopSpeaking');
    } catch (_) {}
  }

  Future<String> startSpeechRecognition({String language = 'en-US'}) async {
    final res = await _method.invokeMethod<String>('startSpeechRecognition', {'language': language});
    return res ?? '';
  }

  Future<void> stopSpeechRecognition() async {
    try {
      await _method.invokeMethod('stopSpeechRecognition');
    } catch (_) {}
  }

  Future<bool> requestScreenMirrorCapture() async {
    try {
      return await _method.invokeMethod<bool>('requestScreenMirrorCapture') ?? false;
    } catch (_) {
      return false;
    }
  }

  Future<void> stopScreenMirrorCapture() async {
    try {
      await _method.invokeMethod('stopScreenMirrorCapture');
    } catch (_) {}
  }
}
