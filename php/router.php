<?php
// Router for PHP's built-in server (php -S 127.0.0.1:PORT -t <ui-dir> router.php).
//   /adminer/*  -> Adminer with the Adrix plugin
//   anything else -> static UI files from the docroot (or 404)
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

if ($path === '/adminer') {
    header('Location: /adminer/');
    return true;
}
if (str_starts_with($path, '/adminer/')) {
    require __DIR__ . '/entry.php';
    return true;
}
// Never execute .php from the docroot — it only serves static UI files.
if (str_ends_with(strtolower($path), '.php')) {
    http_response_code(404);
    return true;
}
return false;
