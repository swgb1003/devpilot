import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class PairingQrPayload {
  const PairingQrPayload({
    required this.pairingId,
    required this.hostCandidates,
    required this.port,
    required this.nonce,
    required this.expiresAt,
    required this.serverFingerprint,
  });

  final String pairingId;
  final List<String> hostCandidates;
  final int port;
  final String nonce;
  final DateTime expiresAt;
  final String serverFingerprint;

  factory PairingQrPayload.parse(String raw) {
    final decoded = jsonDecode(raw);
    if (decoded is! Map<String, dynamic>) {
      throw const PairingException('QRコードの形式が正しくありません。');
    }
    final hosts = decoded['hostCandidates'];
    final parsedHosts =
        hosts is List
            ? hosts
                .whereType<String>()
                .where(_isPrivateIpv4)
                .toList(growable: false)
            : const <String>[];
    final expiresAt = DateTime.tryParse(decoded['expiresAt'] as String? ?? '');
    final port = decoded['port'];
    if (decoded['scheme'] != 'devpilot' ||
        decoded['version'] != 1 ||
        decoded['pairingId'] is! String ||
        decoded['nonce'] is! String ||
        decoded['nonce'].length < 43 ||
        parsedHosts.isEmpty ||
        port is! int ||
        port < 1 ||
        port > 65535 ||
        expiresAt == null ||
        !expiresAt.isAfter(DateTime.now().toUtc()) ||
        decoded['serverPublicKeyFingerprint'] is! String) {
      throw const PairingException(
        'QRコードが無効、または有効期限切れです。PCで新しいQRコードを表示してください。',
      );
    }
    return PairingQrPayload(
      pairingId: decoded['pairingId'] as String,
      hostCandidates: parsedHosts,
      port: port,
      nonce: decoded['nonce'] as String,
      expiresAt: expiresAt.toUtc(),
      serverFingerprint: decoded['serverPublicKeyFingerprint'] as String,
    );
  }

  Map<String, Object> toJson() => {
    'pairingId': pairingId,
    'hostCandidates': hostCandidates,
    'port': port,
    'nonce': nonce,
    'expiresAt': expiresAt.toIso8601String(),
    'serverFingerprint': serverFingerprint,
  };

  factory PairingQrPayload.fromStoredJson(Map<String, dynamic> json) =>
      PairingQrPayload(
        pairingId: json['pairingId'] as String,
        hostCandidates: (json['hostCandidates'] as List).cast<String>(),
        port: json['port'] as int,
        nonce: json['nonce'] as String,
        expiresAt: DateTime.parse(json['expiresAt'] as String).toUtc(),
        serverFingerprint: json['serverFingerprint'] as String,
      );
}

class PairingPollResult {
  const PairingPollResult({required this.status, this.isPaired = false});

  final String status;
  final bool isPaired;
}

class PairingException implements Exception {
  const PairingException(this.message);

  final String message;

  @override
  String toString() => message;
}

class PairingRepository {
  PairingRepository({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const _accessTokenKey = 'pairing.accessToken';
  static const _refreshTokenKey = 'pairing.refreshToken';
  static const _deviceIdKey = 'pairing.deviceId';
  static const _endpointKey = 'pairing.endpoint';
  static const _fingerprintKey = 'pairing.fingerprint';
  static const _ticketKey = 'pairing.confirmationTicket';
  static const _pendingQrKey = 'pairing.pendingQr';
  static const _privateKeyKey = 'pairing.ed25519.private';
  static const _publicKeyKey = 'pairing.ed25519.public';

  final FlutterSecureStorage _storage;

  Future<void> startPairing(PairingQrPayload payload) async {
    final identity = await _loadOrCreateIdentity();
    final confirmation = await _confirmFirstReachableHost(payload, identity);
    await _storage.write(key: _ticketKey, value: confirmation.ticket);
    await _storage.write(
      key: _pendingQrKey,
      value: jsonEncode(confirmation.payload.toJson()),
    );
  }

  Future<_PendingConfirmation> _confirmFirstReachableHost(
    PairingQrPayload payload,
    _Identity identity,
  ) {
    final completer = Completer<_PendingConfirmation>();
    var failures = 0;
    Object? lastError;
    for (final host in payload.hostCandidates) {
      final endpointPayload = PairingQrPayload(
        pairingId: payload.pairingId,
        hostCandidates: [host],
        port: payload.port,
        nonce: payload.nonce,
        expiresAt: payload.expiresAt,
        serverFingerprint: payload.serverFingerprint,
      );
      unawaited(
        _requestJson(
              endpointPayload,
              'POST',
              '/api/v1/pairings/${payload.pairingId}/confirm',
              body: {
                'nonce': payload.nonce,
                'displayName': _displayName(),
                'publicKey': identity.publicKey,
              },
            )
            .then((body) {
              final ticket = _data(body)['confirmationTicket'];
              if (ticket is! String || ticket.isEmpty) {
                throw const PairingException('PCからペアリング確認情報を受け取れませんでした。');
              }
              if (!completer.isCompleted) {
                completer.complete(
                  _PendingConfirmation(ticket, endpointPayload),
                );
              }
            })
            .catchError((Object error) {
              lastError = error;
              failures += 1;
              if (failures == payload.hostCandidates.length &&
                  !completer.isCompleted) {
                completer.completeError(
                  lastError is PairingException
                      ? lastError!
                      : const PairingException(
                        'PCへ安全に接続できませんでした。同じWi-Fiに接続しているか確認してください。',
                      ),
                );
              }
            }),
      );
    }
    return completer.future;
  }

  Future<PairingPollResult> pollPendingPairing() async {
    final ticket = await _storage.read(key: _ticketKey);
    final rawPayload = await _storage.read(key: _pendingQrKey);
    if (ticket == null || rawPayload == null) {
      throw const PairingException('確認待ちのペアリングはありません。');
    }
    final payload = PairingQrPayload.fromStoredJson(
      jsonDecode(rawPayload) as Map<String, dynamic>,
    );
    final body = await _requestJson(
      payload,
      'GET',
      '/api/v1/pairings/${payload.pairingId}/delivery',
      headers: {'X-DevPilot-Confirmation': ticket},
    );
    final data = _data(body);
    final state = data['state'];
    if (state is! Map<String, dynamic> || state['status'] is! String) {
      throw const PairingException('PCからのペアリング状態が正しくありません。');
    }
    final status = state['status'] as String;
    final tokens = data['tokens'];
    if (status != 'approved' || tokens is! Map<String, dynamic>) {
      return PairingPollResult(status: status);
    }
    final accessToken = tokens['accessToken'];
    final refreshToken = tokens['refreshToken'];
    final deviceId = tokens['deviceId'];
    if (accessToken is! String ||
        refreshToken is! String ||
        deviceId is! String) {
      throw const PairingException('PCからの認証情報が正しくありません。');
    }
    await _storage.write(key: _accessTokenKey, value: accessToken);
    await _storage.write(key: _refreshTokenKey, value: refreshToken);
    await _storage.write(key: _deviceIdKey, value: deviceId);
    await _storage.write(
      key: _endpointKey,
      value: '${payload.hostCandidates.first}:${payload.port}',
    );
    await _storage.write(
      key: _fingerprintKey,
      value: payload.serverFingerprint,
    );
    await _storage.delete(key: _ticketKey);
    await _storage.delete(key: _pendingQrKey);
    return const PairingPollResult(status: 'approved', isPaired: true);
  }

  Future<bool> reconnect() async {
    final accessToken = await _storage.read(key: _accessTokenKey);
    final payload = await _storedEndpointPayload();
    if (accessToken == null || payload == null) return false;
    try {
      await _requestJson(
        payload,
        'GET',
        '/api/v1/pairings/me',
        headers: {'Authorization': 'Bearer $accessToken'},
      );
      return true;
    } on PairingException {
      final refreshToken = await _storage.read(key: _refreshTokenKey);
      if (refreshToken == null) return false;
      try {
        final body = await _requestJson(
          payload,
          'POST',
          '/api/v1/auth/refresh',
          headers: {'Authorization': 'Bearer $refreshToken'},
        );
        final data = _data(body);
        final nextToken = data['accessToken'];
        if (nextToken is! String) return false;
        await _storage.write(key: _accessTokenKey, value: nextToken);
        return true;
      } on PairingException {
        return false;
      }
    }
  }

  Future<void> unpair() async {
    final accessToken = await _storage.read(key: _accessTokenKey);
    final payload = await _storedEndpointPayload();
    if (accessToken != null && payload != null) {
      try {
        await _requestJson(
          payload,
          'DELETE',
          '/api/v1/pairings/me',
          headers: {'Authorization': 'Bearer $accessToken'},
        );
      } on PairingException {
        // Local credentials must still be removed when the PC is unavailable.
      }
    }
    await _storage.delete(key: _accessTokenKey);
    await _storage.delete(key: _refreshTokenKey);
    await _storage.delete(key: _deviceIdKey);
    await _storage.delete(key: _endpointKey);
    await _storage.delete(key: _fingerprintKey);
    await _storage.delete(key: _ticketKey);
    await _storage.delete(key: _pendingQrKey);
  }

  Future<_Identity> _loadOrCreateIdentity() async {
    final existingPublic = await _storage.read(key: _publicKeyKey);
    final existingPrivate = await _storage.read(key: _privateKeyKey);
    if (existingPublic != null && existingPrivate != null) {
      return _Identity(publicKey: existingPublic);
    }
    final keyPair = await Ed25519().newKeyPair();
    final publicKey = await keyPair.extractPublicKey();
    final privateKey = await keyPair.extractPrivateKeyBytes();
    final encodedPublicKey = base64UrlEncode(publicKey.bytes);
    await _storage.write(key: _publicKeyKey, value: encodedPublicKey);
    await _storage.write(
      key: _privateKeyKey,
      value: base64UrlEncode(privateKey),
    );
    return _Identity(publicKey: encodedPublicKey);
  }

  Future<PairingQrPayload?> _storedEndpointPayload() async {
    final endpoint = await _storage.read(key: _endpointKey);
    final fingerprint = await _storage.read(key: _fingerprintKey);
    if (endpoint == null || fingerprint == null) return null;
    final separator = endpoint.lastIndexOf(':');
    if (separator < 1) return null;
    final host = endpoint.substring(0, separator);
    final port = int.tryParse(endpoint.substring(separator + 1));
    if (!_isPrivateIpv4(host) || port == null) return null;
    return PairingQrPayload(
      pairingId: await _storage.read(key: _deviceIdKey) ?? '',
      hostCandidates: [host],
      port: port,
      nonce: '',
      expiresAt: DateTime.now().toUtc().add(const Duration(days: 1)),
      serverFingerprint: fingerprint,
    );
  }

  Future<Map<String, dynamic>> _requestJson(
    PairingQrPayload payload,
    String method,
    String path, {
    Map<String, String> headers = const {},
    Map<String, Object>? body,
  }) async {
    final client = HttpClient();
    client.badCertificateCallback =
        (certificate, host, port) => _fingerprintsMatch(
          sha256.convert(certificate.der).toString(),
          payload.serverFingerprint,
        );
    try {
      final request = await client
          .openUrl(
            method,
            Uri.parse(
              'https://${payload.hostCandidates.first}:${payload.port}$path',
            ),
          )
          .timeout(const Duration(seconds: 8));
      headers.forEach(request.headers.set);
      request.headers.contentType = ContentType.json;
      if (body != null) request.write(jsonEncode(body));
      final response = await request.close().timeout(
        const Duration(seconds: 10),
      );
      final raw = await utf8
          .decodeStream(response)
          .timeout(const Duration(seconds: 10));
      final decoded = raw.isEmpty ? <String, dynamic>{} : jsonDecode(raw);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final error = decoded is Map<String, dynamic> ? decoded['error'] : null;
        final message = error is Map<String, dynamic> ? error['message'] : null;
        throw PairingException(message is String ? message : 'PCへの接続に失敗しました。');
      }
      if (decoded is! Map<String, dynamic>) {
        throw const PairingException('PCからの応答が正しくありません。');
      }
      return decoded;
    } on TimeoutException {
      throw const PairingException('PCへの接続がタイムアウトしました。');
    } on HandshakeException {
      throw const PairingException('PCの証明書指紋を確認できませんでした。接続を中止しました。');
    } on SocketException {
      throw const PairingException('PCへ接続できません。同じWi-Fiに接続しているか確認してください。');
    } finally {
      client.close(force: true);
    }
  }

  Map<String, dynamic> _data(Map<String, dynamic> response) {
    final data = response['data'];
    if (data is! Map<String, dynamic>) {
      throw const PairingException('PCからの応答が正しくありません。');
    }
    return data;
  }

  String _displayName() {
    final version = Platform.operatingSystemVersion.replaceAll(
      RegExp(r'\s+'),
      ' ',
    );
    return 'DevPilot Android ${version.length > 48 ? version.substring(0, 48) : version}';
  }
}

class _Identity {
  const _Identity({required this.publicKey});

  final String publicKey;
}

class _PendingConfirmation {
  const _PendingConfirmation(this.ticket, this.payload);

  final String ticket;
  final PairingQrPayload payload;
}

bool _fingerprintsMatch(String observed, String expected) {
  String normalize(String value) => value
      .trim()
      .replaceFirst(RegExp(r'^sha256/', caseSensitive: false), '')
      .toUpperCase()
      .replaceAll(RegExp(r'[^A-F0-9]'), '');
  return normalize(observed) == normalize(expected);
}

bool _isPrivateIpv4(String value) {
  final parts = value.split('.').map(int.tryParse).toList(growable: false);
  if (parts.length != 4 ||
      parts.any((part) => part == null || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] == 10 ||
      (parts[0] == 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] == 192 && parts[1] == 168);
}
