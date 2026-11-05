<?php
// Adminer entry point: registers the Adrix plugin via adminer_object().
function adminer_object() {
    require_once __DIR__ . '/adrix-plugin.php';
    return new Adminer\Plugins([new AdrixPlugin()]);
}

chdir(__DIR__); // so Adminer doesn't look for adminer-plugins/ in the docroot
require __DIR__ . '/adminer.php';
