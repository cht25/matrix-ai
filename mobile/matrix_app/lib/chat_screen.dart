import 'dart:convert';
import 'package:flutter/material.dart';
import 'api.dart';
import 'config.dart';
import 'update_service.dart';

class _StepItem {
  final String label;
  final String? detail;
  final int? durationMs;

  const _StepItem({required this.label, this.detail, this.durationMs});

  factory _StepItem.fromJson(Map<String, dynamic> m) => _StepItem(
        label: (m['label'] ?? 'Step').toString(),
        detail: m['detail']?.toString(),
        durationMs: m['durationMs'] is num ? (m['durationMs'] as num).toInt() : null,
      );
}

class _Message {
  final String role; // 'user' | 'assistant'
  final String content;
  final String? model;
  final String? provider;
  final String? tier;
  final String? imageDataUrl;
  final List<_StepItem> steps;

  const _Message({
    required this.role,
    required this.content,
    this.model,
    this.provider,
    this.tier,
    this.imageDataUrl,
    this.steps = const [],
  });
}

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});
  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final List<_Message> _messages = [];
  String? _conversationId;
  String _mode = 'general'; // general | code | study | image
  bool _sending = false;
  String? _error;

  static const _modes = <({String id, String label, IconData icon})>[
    (id: 'general', label: 'Fast / Auto', icon: Icons.bolt_rounded),
    (id: 'code', label: 'Code (GLM)', icon: Icons.code_rounded),
    (id: 'study', label: 'Deep Study', icon: Icons.psychology_outlined),
    (id: 'image', label: 'GLM Image', icon: Icons.palette_outlined),
  ];

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _sending) return;
    _input.clear();
    setState(() {
      _messages.add(_Message(role: 'user', content: text));
      _sending = true;
      _error = null;
    });

    try {
      if (_mode == 'image') {
        final res = await MatrixApi.instance.sendAiGateway({
          'action': 'image',
          'message': text,
          'prompt': text,
          if (_conversationId != null) 'conversation_id': _conversationId,
        });
        _conversationId = res['conversation_id']?.toString() ?? _conversationId;
        final imgMap = res['image'] is Map ? Map<String, dynamic>.from(res['image'] as Map) : null;
        final b64 = res['b64_json']?.toString() ?? '';
        final mime = imgMap?['mime']?.toString() ?? res['mime_type']?.toString() ?? 'image/png';
        final dataUrl = imgMap?['data_url']?.toString() ??
            (b64.isNotEmpty ? 'data:$mime;base64,$b64' : res['image_url']?.toString());
        final rawSteps = (res['steps'] as List?) ?? const [];
        final parsedSteps = rawSteps
            .whereType<Map>()
            .map((m) => _StepItem.fromJson(Map<String, dynamic>.from(m)))
            .toList();
        setState(() {
          _messages.add(_Message(
            role: 'assistant',
            content: 'Generated with ${res['model'] ?? 'GLM CogView'}',
            model: res['model']?.toString(),
            provider: (res['provider'] ?? 'glm').toString().toUpperCase(),
            imageDataUrl: dataUrl,
            steps: parsedSteps.isNotEmpty
                ? parsedSteps
                : const [
                    _StepItem(label: 'Prompt prepared', detail: 'GLM CogView'),
                    _StepItem(label: 'Image rendered'),
                  ],
          ));
        });
      } else {
        final priorHistory = _messages.length > 1
            ? _messages
                .sublist(0, _messages.length - 1)
                .map((m) => {'role': m.role, 'content': m.content})
                .toList(growable: false)
            : const <Map<String, String>>[];
        final res = await MatrixApi.instance.sendAiGateway({
          'action': 'chat',
          'mode': _mode,
          'message': text,
          'history': priorHistory,
          if (_conversationId != null) 'conversation_id': _conversationId,
        });
        _conversationId = res['conversation_id']?.toString() ?? _conversationId;
        final reply = (res['reply'] ?? res['content'] ?? '').toString();
        final rawSteps = (res['steps'] as List?) ?? const [];
        final parsedSteps = rawSteps
            .whereType<Map>()
            .map((m) => _StepItem.fromJson(Map<String, dynamic>.from(m)))
            .toList();
        if (reply.isEmpty) throw const ApiException('AI_UNAVAILABLE', 503);
        setState(() {
          _messages.add(_Message(
            role: 'assistant',
            content: reply,
            model: res['model']?.toString(),
            provider: res['provider']?.toString(),
            tier: res['tier']?.toString(),
            steps: parsedSteps,
          ));
        });
      }
      await Future<void>.delayed(const Duration(milliseconds: 50));
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    } on ApiException catch (e) {
      setState(() => _error = 'AI service error (${e.code}).');
    } catch (_) {
      setState(() => _error = 'Network error — check your connection.');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
          child: Row(
            children: [
              for (final m in _modes)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ChoiceChip(
                    avatar: Icon(m.icon, size: 15),
                    label: Text(m.label, style: const TextStyle(fontSize: 12)),
                    selected: _mode == m.id,
                    onSelected: (_) => setState(() => _mode = m.id),
                  ),
                ),
              ActionChip(
                avatar: const Icon(Icons.open_in_new_rounded, size: 14),
                label: const Text('Web Workspace', style: TextStyle(fontSize: 12)),
                onPressed: () => UpdateService.openWebChat(),
              ),
            ],
          ),
        ),
        if (_error != null)
          Container(
            width: double.infinity,
            color: const Color(0xFF3A1216),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Text(_error!, style: const TextStyle(color: Color(0xFFFCA5A5), fontSize: 13)),
          ),
        Expanded(
          child: _messages.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text(
                          'MATRIX AI',
                          style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          'GLM powers coding, web dev & high-load reasoning · gpt-oss-120b handles fast everyday tasks · CogView generates images.\nSynced with ${MatrixConfig.chatUri}',
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: Colors.white60, fontSize: 12.5, height: 1.45),
                        ),
                      ],
                    ),
                  ),
                )
              : ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.all(16),
                  itemCount: _messages.length + (_sending ? 1 : 0),
                  itemBuilder: (context, i) {
                    if (i == _messages.length) {
                      return const Align(
                        alignment: Alignment.centerLeft,
                        child: _CompactLiveStepPill(),
                      );
                    }
                    final m = _messages[i];
                    final isUser = m.role == 'user';
                    return Align(
                      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
                      child: Container(
                        margin: const EdgeInsets.symmetric(vertical: 6),
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                        constraints: const BoxConstraints(maxWidth: 520),
                        decoration: BoxDecoration(
                          color: isUser ? const Color(0xFF143524) : const Color(0xFF141418),
                          borderRadius: BorderRadius.circular(14),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (!isUser && m.steps.isNotEmpty) ...[
                              _CompactStepsAccordion(
                                steps: m.steps,
                                provider: m.provider,
                                tier: m.tier,
                              ),
                              const SizedBox(height: 8),
                            ],
                            if (m.imageDataUrl != null) ...[
                              _RenderedImage(dataOrUrl: m.imageDataUrl!),
                              const SizedBox(height: 8),
                            ],
                            SelectableText(m.content, style: const TextStyle(height: 1.45)),
                            if (!isUser && (m.provider != null || m.model != null)) ...[
                              const SizedBox(height: 6),
                              Text(
                                [m.provider, m.model].whereType<String>().where((s) => s.isNotEmpty).join(' · '),
                                style: const TextStyle(fontSize: 10.5, color: Colors.white38),
                              ),
                            ],
                          ],
                        ),
                      ),
                    );
                  },
                ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
            child: Row(
              children: [
                if (_messages.isNotEmpty)
                  IconButton(
                    tooltip: 'New chat',
                    onPressed: _sending
                        ? null
                        : () => setState(() {
                              _messages.clear();
                              _conversationId = null;
                            }),
                    icon: const Icon(Icons.add_comment_outlined, size: 20),
                  ),
                Expanded(
                  child: TextField(
                    controller: _input,
                    minLines: 1,
                    maxLines: 5,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _send(),
                    decoration: InputDecoration(
                      hintText: _mode == 'image' ? 'Describe an image for GLM CogView…' : 'Message MATRIX…',
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  onPressed: _sending ? null : _send,
                  icon: const Icon(Icons.arrow_upward),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _CompactLiveStepPill extends StatelessWidget {
  const _CompactLiveStepPill();

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(
        color: const Color(0xFF141418),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.white12),
      ),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 2)),
          SizedBox(width: 8),
          Text('Working…', style: TextStyle(fontSize: 12, color: Colors.white70)),
        ],
      ),
    );
  }
}

/// Arena-style compact collapsible step pill: collapsed by default, expands on tap.
class _CompactStepsAccordion extends StatefulWidget {
  final List<_StepItem> steps;
  final String? provider;
  final String? tier;

  const _CompactStepsAccordion({required this.steps, this.provider, this.tier});

  @override
  State<_CompactStepsAccordion> createState() => _CompactStepsAccordionState();
}

class _CompactStepsAccordionState extends State<_CompactStepsAccordion> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final count = widget.steps.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => setState(() => _open = !_open),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: const Color(0xFF1C1C22),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Colors.white10),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  _open ? Icons.keyboard_arrow_down_rounded : Icons.keyboard_arrow_right_rounded,
                  size: 15,
                  color: Colors.white60,
                ),
                const SizedBox(width: 4),
                Text(
                  'Worked · $count ${count == 1 ? 'step' : 'steps'}',
                  style: const TextStyle(fontSize: 11.5, color: Colors.white70, fontWeight: FontWeight.w500),
                ),
                if (widget.provider != null && widget.provider!.isNotEmpty) ...[
                  const SizedBox(width: 6),
                  Text(
                    '· ${widget.provider}${widget.tier == 'low' ? ' (fast)' : ''}',
                    style: const TextStyle(fontSize: 11, color: Colors.white38),
                  ),
                ],
              ],
            ),
          ),
        ),
        if (_open)
          Padding(
            padding: const EdgeInsets.only(top: 6, left: 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final s in widget.steps)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.check_circle_outline, size: 12, color: Color(0xFF22C55E)),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text(
                            s.detail != null && s.detail!.isNotEmpty ? '${s.label} · ${s.detail}' : s.label,
                            style: const TextStyle(fontSize: 11, color: Colors.white60),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class _RenderedImage extends StatelessWidget {
  final String dataOrUrl;
  const _RenderedImage({required this.dataOrUrl});

  @override
  Widget build(BuildContext context) {
    if (dataOrUrl.startsWith('data:image/') && dataOrUrl.contains(';base64,')) {
      final b64 = dataOrUrl.split(';base64,').last;
      final bytes = base64Decode(b64);
      return ClipRRect(
        borderRadius: BorderRadius.circular(10),
        child: Image.memory(bytes, fit: BoxFit.cover),
      );
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: Image.network(dataOrUrl, fit: BoxFit.cover),
    );
  }
}
