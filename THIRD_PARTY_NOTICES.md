# Third-party notices

Adrix itself is licensed under the MIT License (see `LICENSE`).
Adrix packages ship the following third-party software, which keeps its own license.

## Adminer

- Copyright 2007 Jakub Vrána — https://www.adminer.org/
- Dual-licensed under Apache License 2.0 **or** GPL 2.0. Adrix redistributes it under the
  **Apache License 2.0** — full text in `licenses/Apache-2.0.txt`.
- Shipped unmodified (`adminer/adminer.php`, English-only build, original copyright header kept).
  Adrix integrates with it only through Adminer's public plugin API (`adminer/adrix-plugin.php`).

## PHP

- This product includes PHP software, freely available from <http://www.php.net/software/>.
- Copyright (c) 1999 - 2026 The PHP Group. Licensed under the PHP License, version 3.01 —
  full text in `licenses/PHP-3.01.txt`. PHP includes the Zend Engine, freely available at
  <http://www.zend.com>.
- The binary is a static build made with static-php-cli (MIT, https://github.com/crazywhalecc/static-php-cli).
  It statically links libraries under their own permissive licenses, among them OpenSSL
  (Apache-2.0), libpq (PostgreSQL License), SQLite (public domain), zlib (zlib License),
  oniguruma (BSD-2-Clause) and others (the Linux build is the upstream "bulk" prebuilt).

## Rust crates and npm packages

The Rust core and the UI use open-source crates/packages (Tauri, tokio, russh, keyring,
chacha20poly1305, serde, …) licensed under MIT and/or Apache-2.0 (and compatible permissive
licenses). See `src-tauri/Cargo.lock` and `pnpm-lock.yaml` for the exact list.
