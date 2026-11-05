<?php
/** Integrates Adminer with the Adrix desktop app. */
class AdrixPlugin extends Adminer\Plugin {
    /** Allow framing only by the same origin (the app UI). */
    function headers() {
        header_remove('X-Frame-Options');
        header('X-Frame-Options: SAMEORIGIN');
    }

    /** No external requests (adminer.org); frames only from our own origin. */
    function csp($csp) {
        foreach ($csp as &$directives) {
            $directives['connect-src'] = "'self'";
            $directives['frame-src'] = "'none'";
            $directives['frame-ancestors'] = "'self'";
        }
        return $csp;
    }

    /**
     * Theme follows the app (cookie adrix_theme = light|dark).
     * Adminer decides whether to load dark.css from the modes returned by css():
     * only 'dark' forces dark, only 'light' forces light.
     */
    function css() {
        $theme = $_COOKIE['adrix_theme'] ?? '';
        if ($theme !== 'light' && $theme !== 'dark') {
            return null; // Adminer default: follow prefers-color-scheme
        }
        // cache-busting: the file changes between app versions
        $file = ($_SERVER['DOCUMENT_ROOT'] ?? '') . '/adminer-theme.css';
        $version = is_file($file) ? filemtime($file) : 0;
        return ["/adminer-theme.css?v=$version" => $theme];
    }

    function verifyVersion() {
        return false;
    }

    function donation() {
        return '';
    }

    function serviceWorker() {
    }

    function manifest() {
        return [];
    }

    /**
     * The login form is posted by the app UI, not typed by a person.
     * Instead of Adminer's CSRF token we check the per-process secret (ADRIX_TOKEN)
     * known only to the Rust core and the app window.
     * true = Adminer verifies its own token (normal path), false = skip it.
     */
    function verifyLoginToken() {
        $expected = (string) getenv('ADRIX_TOKEN');
        $given = (string) ($_POST['auth']['adrix'] ?? '');
        return !($expected !== '' && hash_equals($expected, $given));
    }

    /** The server listens on 127.0.0.1 only; allow empty passwords (SQLite, trust auth). */
    function login($login, $password) {
        return true;
    }
}
