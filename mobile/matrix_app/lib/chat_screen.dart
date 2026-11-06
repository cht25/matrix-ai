/// Minimal chat against the MATRIX AI gateway (POST /api/ai, non-streaming
/// compare-style JSON path is used for reliability on mobile networks; the web
/// app remains the full streaming experience).
library;

import 'package:flutter/material.dart';
import 'api.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.api});
  final MatrixApi api;
  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _input = TextEditingController();
  final _messages = <Map<String, String>>[];
  bool _busy = false;

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _messages.add({'role': 'user', 'content': text});
      _input.clear();
    });
    try {
      // Use the compare endpoint with a single lane as a simple, reliable
      // non-streaming completion path for the companion app.
      final res = await widget.api.postJson('/api/ai/compare', {
        'message': text,
        'lanes': ['balanced'],
      });
      final results = (res['results'] as List?) ?? [];
      final first = results.isNotEmpty ? (results.first as Map) : null;
      final content = first != null && first['ok'] == true ? first['content']?.toString() : 'Error: ${first?['error'] ?? 'unknown'}';
      setState(() => _messages.add({'role': 'assistant', 'content': content ?? ''}));
    } on ApiException catch (e) {
      setState(() => _messages.add({'role': 'assistant', 'content': 'Error: ${e.code}'}));
    } finally {
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('MATRIX chat')),
      body: Column(
        children: [
          Expanded(
            child: ListView.builder(
              padding: const EdgeInsets.all(12),
              itemCount: _messages.length,
              itemBuilder: (context, i) {
                final m = _messages[i];
                final isUser = m['role'] == 'user';
                return Align(
                  alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
                  child: Container(
                    margin: const EdgeInsets.symmetric(vertical: 4),
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: isUser ? Theme.of(context).colorScheme.primary : Theme.of(context).colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(m['content'] ?? '', style: TextStyle(color: isUser ? Colors.white : null)),
                  ),
                );
              },
            ),
          ),
          SafeArea(
            child: Row(
              children: [
                Expanded(child: TextField(controller: _input, decoration: const InputDecoration(hintText: 'Message MATRIX…', border: OutlineInputBorder()), onSubmitted: (_) => _send())),
                IconButton(icon: _busy ? const CircularProgressIndicator() : const Icon(Icons.send), onPressed: _send),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
