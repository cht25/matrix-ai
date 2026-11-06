/// Auth gate + login screen: email/password (and providers enabled in the
/// Firebase project) via firebase_auth, then straight into the workspace —
/// no device permission is requested at first login.
library;

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'api.dart';
import 'home_screen.dart';

class AuthGate extends StatelessWidget {
  const AuthGate({super.key});
  @override
  Widget build(BuildContext context) {
    return StreamBuilder<User?>(
      stream: FirebaseAuth.instance.authStateChanges(),
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }
        if (snap.data != null) return HomeScreen(api: MatrixApi());
        return const LoginScreen();
      },
    );
  }
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _signIn() async {
    setState(() { _busy = true; _error = null; });
    try {
      await FirebaseAuth.instance.signInWithEmailAndPassword(
        email: _email.text.trim(),
        password: _password.text,
      );
      await MatrixApi.rememberSignedIn();
    } on FirebaseAuthException catch (e) {
      setState(() => _error = e.message ?? 'Sign-in failed');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _register() async {
    setState(() { _busy = true; _error = null; });
    try {
      await FirebaseAuth.instance.createUserWithEmailAndPassword(
        email: _email.text.trim(),
        password: _password.text,
      );
      await MatrixApi.rememberSignedIn();
    } on FirebaseAuthException catch (e) {
      setState(() => _error = e.message ?? 'Registration failed');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 380),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('MATRIX', style: TextStyle(fontSize: 32, fontWeight: FontWeight.w700, letterSpacing: 2)),
                  const SizedBox(height: 4),
                  const Text('Sign in to your AI workspace', style: TextStyle(color: Colors.grey)),
                  const SizedBox(height: 28),
                  TextField(controller: _email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email', border: OutlineInputBorder())),
                  const SizedBox(height: 12),
                  TextField(controller: _password, obscureText: true, decoration: const InputDecoration(labelText: 'Password', border: OutlineInputBorder())),
                  if (_error != null) ...[const SizedBox(height: 12), Text(_error!, style: const TextStyle(color: Colors.red))],
                  const SizedBox(height: 16),
                  FilledButton(onPressed: _busy ? null : _signIn, child: _busy ? const CircularProgressIndicator() : const Text('Sign in')),
                  const SizedBox(height: 8),
                  OutlinedButton(onPressed: _busy ? null : _register, child: const Text('Create account')),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
