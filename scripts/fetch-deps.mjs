#!/usr/bin/env node
// Downloads dependencies that are not stored in git:
//   php/adminer.php                         — Adminer (all drivers, English only)
//   src-tauri/binaries/php-<target>[.exe]   — static PHP (Tauri sidecar)
//
// Usage:
//   node scripts/fetch-deps.mjs                 # prebuilt PHP from dl.static-php.dev
//   node scripts/fetch-deps.mjs --php=system    # copy php from PATH (dev only)
//   node scripts/fetch-deps.mjs --php=skip      # PHP is already in place (e.g. built in CI)
//   node scripts/fetch-deps.mjs --force         # re-download
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ADMINER_VERSION = process.env.ADMINER_VERSION ?? "6.3.0";
const PHP_VERSION_LINUX = process.env.PHP_VERSION_LINUX ?? "8.4.23";
const PHP_VERSION_WIN = process.env.PHP_VERSION_WIN ?? "8.4.20";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const phpMode = [...args].find((a) => a.startsWith("--php="))?.slice(6) ?? "prebuilt";

const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)[1].trim();
const isWin = triple.includes("windows");
const phpTarget = join(root, "src-tauri", "binaries", `php-${triple}${isWin ? ".exe" : ""}`);

async function download(url, dest) {
  console.log(`↓ ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function fetchAdminer() {
  const dest = join(root, "php", "adminer.php");
  if (existsSync(dest) && !force) return console.log(`✓ ${dest}`);
  await download(`https://github.com/vrana/adminer/releases/download/v${ADMINER_VERSION}/adminer-${ADMINER_VERSION}-en.php`, dest);
}

async function fetchPhp() {
  mkdirSync(dirname(phpTarget), { recursive: true });
  if (phpMode === "skip") {
    if (!existsSync(phpTarget)) throw new Error(`--php=skip, but ${phpTarget} does not exist`);
    return console.log(`✓ ${phpTarget}`);
  }
  if (existsSync(phpTarget) && !force) return console.log(`✓ ${phpTarget}`);

  if (phpMode === "system") {
    const which = execFileSync(isWin ? "where" : "which", ["php"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    copyFileSync(which, phpTarget);
    console.log(`✓ ${which} → ${phpTarget}`);
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), "adrix-php-"));
  try {
    let archive, binName;
    if (triple.startsWith("x86_64-unknown-linux")) {
      // bulk: includes mysqli, pdo_mysql, pgsql, sqlite3, mbstring, openssl, zlib
      archive = join(tmp, "php.tar.gz");
      binName = "php";
      await download(`https://dl.static-php.dev/static-php-cli/bulk/php-${PHP_VERSION_LINUX}-cli-linux-x86_64.tar.gz`, archive);
    } else if (triple.startsWith("aarch64-unknown-linux")) {
      archive = join(tmp, "php.tar.gz");
      binName = "php";
      await download(`https://dl.static-php.dev/static-php-cli/bulk/php-${PHP_VERSION_LINUX}-cli-linux-aarch64.tar.gz`, archive);
    } else if (isWin) {
      // NOTE: the prebuilt Windows PHP lacks pgsql — release builds compile PHP in CI (see .github/workflows/release.yml).
      console.warn("! prebuilt Windows PHP has no pgsql; use the CI build for PostgreSQL");
      archive = join(tmp, "php.zip");
      binName = "php.exe";
      await download(`https://dl.static-php.dev/static-php-cli/windows/spc-max/php-${PHP_VERSION_WIN}-cli-win.zip`, archive);
    } else {
      throw new Error(`no prebuilt PHP for ${triple}, use --php=system`);
    }
    execFileSync("tar", ["-xf", archive, "-C", tmp], { stdio: "inherit" });
    copyFileSync(join(tmp, binName), phpTarget);
    if (!isWin) chmodSync(phpTarget, 0o755);
    console.log(`✓ ${phpTarget}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

await fetchAdminer();
await fetchPhp();
