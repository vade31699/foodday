<?php
declare(strict_types=1);

require_once __DIR__ . '/env.php';

/**
 * FOODAY — outbound mail.
 *
 * This is the project's only outbound mail path. Anything that needs to send a
 * message (two-factor codes, password resets) goes through send_mail(), so
 * there is exactly one place to change when a different mailer is installed.
 *
 * ---------------------------------------------------------------------------
 * Swapping the transport
 * ---------------------------------------------------------------------------
 * MAIL_DRIVER in .env selects it:
 *
 *   smtp  (default) the built-in client below. Works with Gmail, Outlook and
 *                  any other SMTP server, with no Composer dependency.
 *   mail             PHP's own mail(), for hosts that already route local mail.
 *   file             Writes each message to a log file instead of sending it.
 *                  For local testing only — it lets the full sign-in flow be
 *                  checked before real SMTP credentials exist.
 *   none             Sending is off. send_mail() reports "not configured" and
 *                  every feature that depends on mail refuses to switch itself
 *                  on rather than leaving the account unusable.
 *
 * A custom mailer (PHPMailer, Symfony Mailer, an API like Mailgun) only needs
 * its own branch in the send() switch below — nothing else in the app changes.
 */

/**
 * Deliberately self-contained: this file must be usable without config.php
 * having been loaded, so it does not borrow valid_email() from it.
 */
function mailer_valid_email(string $value): bool
{
    return (bool) filter_var($value, FILTER_VALIDATE_EMAIL);
}

/** @return array{sent:bool,reason:string} */
function send_mail(string $to, string $subject, string $html, string $text = ''): array
{
    $to = trim($to);
    if ($to === '' || !mailer_valid_email($to)) {
        return ['sent' => false, 'reason' => 'The recipient address is not a valid email.'];
    }

    if ($text === '') {
        $text = mail_plain_text($html);
    }

    return mail_transport_dispatch($to, $subject, $html, $text);
}

function mail_transport_dispatch(string $to, string $subject, string $html, string $text): array
{
    $driver = strtolower(env('MAIL_DRIVER', 'smtp'));

    if ($driver === 'none') {
        return ['sent' => false, 'reason' => 'Outbound mail is switched off (MAIL_DRIVER=none).'];
    }

    $fromEmail = env('MAIL_FROM', env('MAIL_SMTP_USER', ''));
    $fromName  = env('MAIL_FROM_NAME', 'FOODAY');
    if (!mailer_valid_email($fromEmail)) {
        return ['sent' => false, 'reason' => 'MAIL_FROM is missing or is not a valid email address.'];
    }

    if ($driver === 'mail') {
        $headers = [
            'From: ' . mail_header_name($fromName) . ' <' . $fromEmail . '>',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
        ];
        $ok = @mail($to, mail_subject($subject), $text, implode("\r\n", $headers));
        return $ok
            ? ['sent' => true, 'reason' => '']
            : ['sent' => false, 'reason' => 'PHP mail() could not hand the message to the local mail server.'];
    }

    if ($driver === 'file') {
        // Local/testing transport: appends the message to a file instead of
        // sending it. Lets the whole sign-in flow be exercised before real SMTP
        // credentials exist. Never use this in production.
        $dir = env('MAIL_FILE_DIR', '');
        $dir = $dir === '' ? (sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'fooday-mail') : rtrim($dir, "/\\");
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return ['sent' => false, 'reason' => 'MAIL_FILE_DIR could not be created: ' . $dir];
        }
        $line = '=== ' . date('c') . ' ===' . "\n"
            . 'To: ' . $to . "\n"
            . 'Subject: ' . $subject . "\n"
            . 'From: ' . mail_header_name($fromName) . ' <' . $fromEmail . '>' . "\n\n"
            . $text . "\n\n";
        $file = $dir . DIRECTORY_SEPARATOR . 'outbox.log';
        if (@file_put_contents($file, $line, FILE_APPEND | LOCK_EX) === false) {
            return ['sent' => false, 'reason' => 'Could not write to the mail file: ' . $file];
        }
        return ['sent' => true, 'reason' => ''];
    }

    if ($driver !== 'smtp') {
        return ['sent' => false, 'reason' => 'Unknown MAIL_DRIVER "' . $driver . '".'];
    }

    $host     = env('MAIL_SMTP_HOST', 'smtp.gmail.com');
    $port     = env_int('MAIL_SMTP_PORT', 465);
    $user     = env('MAIL_SMTP_USER', '');
    $pass     = env('MAIL_SMTP_PASS', '');
    $implicit = env_bool('MAIL_SMTP_IMPLICIT_TLS', $port === 465);
    $timeout  = max(3, min(60, env_int('MAIL_SMTP_TIMEOUT', 15)));

    // Refusing up front keeps a half-filled .env from producing a confusing
    // authentication error, and — more importantly — stops MFA from being
    // enabled when a code could never be delivered.
    if (env_is_placeholder($host) || env_is_placeholder($user) || env_is_placeholder($pass)) {
        return [
            'sent' => false,
            'reason' => 'SMTP is not configured yet. Set MAIL_SMTP_HOST, MAIL_SMTP_USER and '
                      . 'MAIL_SMTP_PASS in .env (a Gmail App Password goes in MAIL_SMTP_PASS).',
        ];
    }

    return smtp_send($host, $port, $implicit, $user, $pass, $fromEmail, $fromName, $to, $subject, $html, $text, $timeout);
}

/**
 * True when a real mail transport is configured. Callers use this to refuse
 * switching on a feature that needs to deliver a code.
 */
function mail_available(): bool
{
    return mail_configured_failure() === '';
}

/** @return array{sent:bool,reason:string} */
function smtp_send(
    string $host,
    int $port,
    bool $implicitTls,
    string $user,
    string $pass,
    string $fromEmail,
    string $fromName,
    string $to,
    string $subject,
    string $html,
    string $text,
    int $timeout
): array {
    if ($implicitTls && !in_array('ssl', stream_get_transports(), true)) {
        return ['sent' => false, 'reason' => 'This PHP build has no OpenSSL support, so a TLS SMTP server cannot be used. Try MAIL_SMTP_PORT=587 with MAIL_SMTP_IMPLICIT_TLS=false.'];
    }

    $remote = ($implicitTls ? 'ssl://' : 'tcp://') . $host . ':' . $port;

    $context = stream_context_create([
        'ssl' => [
            'verify_peer'       => env_bool('MAIL_SMTP_VERIFY_PEER', true),
            'verify_peer_name'  => env_bool('MAIL_SMTP_VERIFY_PEER', true),
            'SNI_enabled'       => true,
            'peer_name'         => $host,
        ],
    ]);

    $errno = 0;
    $errstr = '';
    $fp = @stream_socket_client($remote, $errno, $errstr, $timeout, STREAM_CLIENT_CONNECT, $context);
    if ($fp === false) {
        return ['sent' => false, 'reason' => "Could not connect to {$host}:{$port} ({$errstr})."];
    }
    stream_set_timeout($fp, $timeout);

    try {
        smtp_expect($fp, [220], 'the greeting');

        $hostName = gethostname() ?: 'localhost';
        smtp_command($fp, 'EHLO ' . $hostName, [250], 'EHLO');

        if (!$implicitTls) {
            smtp_command($fp, 'STARTTLS', [220], 'STARTTLS');
            if (!@stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                return ['sent' => false, 'reason' => 'The TLS handshake with ' . $host . ' failed.'];
            }
            smtp_command($fp, 'EHLO ' . $hostName, [250], 'EHLO after STARTTLS');
        }

        // AUTH LOGIN is understood by Gmail, Outlook and SendGrid alike.
        smtp_command($fp, 'AUTH LOGIN', [334], 'AUTH LOGIN');
        smtp_command($fp, base64_encode($user), [334], 'AUTH username');
        smtp_command($fp, base64_encode($pass), [235], 'AUTH password');

        smtp_command($fp, 'MAIL FROM:<' . $fromEmail . '>', [250], 'MAIL FROM');
        smtp_command($fp, 'RCPT TO:<' . $to . '>', [250, 251], 'RCPT TO');
        smtp_command($fp, 'DATA', [354], 'DATA');

        $message = mail_build_message($fromEmail, $fromName, $to, $subject, $html, $text);
        // Dot-stuffing: a line that is just "." would otherwise end DATA early.
        $message = preg_replace('/^\./m', '..', $message) ?? $message;

        fwrite($fp, $message . "\r\n.\r\n");
        smtp_expect($fp, [250], 'the message body');

        fwrite($fp, "QUIT\r\n");
    } catch (Throwable $e) {
        @fclose($fp);
        return ['sent' => false, 'reason' => $e->getMessage()];
    }

    @fclose($fp);
    return ['sent' => true, 'reason' => ''];
}

function smtp_command($fp, string $line, array $expect, string $stage): void
{
    fwrite($fp, $line . "\r\n");
    smtp_expect($fp, $expect, $stage);
}

/** Reads a full (possibly multi-line) SMTP reply and checks its status code. */
function smtp_expect($fp, array $expect, string $stage): string
{
    $reply = '';
    while (true) {
        $chunk = fgets($fp, 2048);
        if ($chunk === false) {
            $meta = stream_get_meta_data($fp);
            $why = !empty($meta['timed_out']) ? 'timed out' : 'the connection closed';
            throw new RuntimeException('The mail server ' . $why . ' while handling ' . $stage . '.');
        }
        $reply .= $chunk;
        // A reply is finished when a line is "250 " (space, not hyphen).
        if (strlen($chunk) >= 4 && $chunk[3] === ' ') {
            break;
        }
        if (strlen($chunk) < 4) {
            break;
        }
    }

    $code = (int) substr(trim($reply), 0, 3);
    if (!in_array($code, $expect, true)) {
        throw new RuntimeException('The mail server rejected ' . $stage . ': ' . trim(preg_replace('/\s+/', ' ', $reply) ?? $reply));
    }
    return $reply;
}

function mail_build_message(
    string $fromEmail,
    string $fromName,
    string $to,
    string $subject,
    string $html,
    string $text
): string {
    $boundary = 'fooday_' . bin2hex(random_bytes(12));
    $messageId = sprintf('<%s@%s>', bin2hex(random_bytes(12)), preg_replace('/[^a-z0-9.-]/i', '', (string) (gethostname() ?: 'fooday')));

    $headers = [
        'Date: ' . gmdate('D, d M Y H:i:s') . ' +0000',
        'From: ' . mail_header_name($fromName) . ' <' . $fromEmail . '>',
        'To: <' . $to . '>',
        'Subject: ' . mail_subject($subject),
        'Message-ID: ' . $messageId,
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
    ];

    $body  = 'This is a multi-part message in MIME format.' . "\r\n\r\n";
    $body .= '--' . $boundary . "\r\n";
    $body .= 'Content-Type: text/plain; charset=utf-8' . "\r\n";
    $body .= 'Content-Transfer-Encoding: 8bit' . "\r\n\r\n";
    $body .= str_replace("\n", "\r\n", $text) . "\r\n";
    $body .= '--' . $boundary . "\r\n";
    $body .= 'Content-Type: text/html; charset=utf-8' . "\r\n";
    $body .= 'Content-Transfer-Encoding: 8bit' . "\r\n\r\n";
    $body .= str_replace("\n", "\r\n", $html) . "\r\n";
    $body .= '--' . $boundary . "--\r\n";

    return implode("\r\n", $headers) . "\r\n\r\n" . $body;
}

/** RFC 2047 encodes a display name or subject that is not plain ASCII. */
function mail_header_name(string $value): string
{
    if (preg_match('/^[\x20-\x7E]*$/', $value) === 1) {
        return '"' . str_replace('"', '\"', $value) . '"';
    }
    return '=?UTF-8?B?' . base64_encode($value) . '?=';
}

function mail_subject(string $subject): string
{
    if (preg_match('/^[\x20-\x7E]*$/', $subject) === 1) {
        return $subject;
    }
    return '=?UTF-8?B?' . base64_encode($subject) . '?=';
}

/** A readable plain-text alternative, derived from the HTML. */
function mail_plain_text(string $html): string
{
    $text = preg_replace('#<(br|/p|/div|/h[1-6]|/tr|/li)[^>]*>#i', "\n", $html) ?? $html;
    $text = strip_tags($text);
    $text = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = preg_replace('/[ \t]+/', ' ', $text) ?? $text;
    $text = preg_replace('/\n{3,}/', "\n\n", $text) ?? $text;
    return trim($text);
}

/**
 * Whether mail is genuinely configured, without attempting a real delivery.
 * Returns the reason it is not usable, or an empty string when it is.
 */
function mail_configured_failure(): string
{
    $driver = strtolower(env('MAIL_DRIVER', 'smtp'));
    if ($driver === 'none') {
        return 'Outbound mail is switched off (MAIL_DRIVER=none).';
    }
    $from = env('MAIL_FROM', env('MAIL_SMTP_USER', ''));
    if (!mailer_valid_email($from)) {
        return 'MAIL_FROM is missing or is not a valid email address.';
    }
    if ($driver === 'mail' || $driver === 'file') {
        return '';
    }
    if ($driver !== 'smtp') {
        return 'Unknown MAIL_DRIVER "' . $driver . '".';
    }
    if (env_is_placeholder(env('MAIL_SMTP_HOST', 'smtp.gmail.com'))
        || env_is_placeholder(env('MAIL_SMTP_USER', ''))
        || env_is_placeholder(env('MAIL_SMTP_PASS', ''))) {
        return 'SMTP is not configured yet. Set MAIL_SMTP_HOST, MAIL_SMTP_USER and MAIL_SMTP_PASS in .env.';
    }
    return '';
}
