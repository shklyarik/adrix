//! Encrypted secrets vault (DB passwords, SSH passwords, key passphrases).
//!
//! All secrets live in one file, `secrets.vault`, encrypted with ChaCha20-Poly1305.
//! The 256-bit vault key is stored in the OS keyring (Secret Service on Linux,
//! Credential Manager on Windows). If no keyring is available, the key is kept in
//! `vault.key` (mode 0600) next to the vault — weaker, but secrets are still not
//! stored as plain text and leaking just the vault file is not enough.
//!
//! File layout: MAGIC (6) | key source (1) | nonce (12) | ciphertext (JSON map + tag)

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};

use crate::error::{Error, Result};
use crate::store::write_private;

const MAGIC: &[u8; 6] = b"ADRXV1";
const KEYRING_SERVICE: &str = "dev.adrix.app";
const KEYRING_USER: &str = "vault-key";
const SRC_KEYRING: u8 = 1;
const SRC_FILE: u8 = 2;

pub struct Vault {
    path: PathBuf,
    cipher: Option<ChaCha20Poly1305>,
    source: u8,
    entries: BTreeMap<String, String>,
}

impl Vault {
    pub fn open(dir: &Path) -> Result<Self> {
        let path = dir.join("secrets.vault");
        let key_file = dir.join("vault.key");
        let existing = match fs::read(&path) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let header_src = existing
            .as_ref()
            .and_then(|b| (b.len() > 7 && b.starts_with(MAGIC)).then(|| b[6]));

        // Use the key source the vault was written with; for a new vault prefer the keyring.
        let (key, source) = match header_src {
            Some(SRC_FILE) => (read_key_file(&key_file), SRC_FILE),
            Some(_) => (keyring_get(), SRC_KEYRING),
            None => match keyring_get_or_create() {
                Some(k) => (Some(k), SRC_KEYRING),
                None => (Some(read_or_create_key_file(&key_file)?), SRC_FILE),
            },
        };

        let mut vault = Vault {
            path,
            cipher: key.map(|k| ChaCha20Poly1305::new(Key::from_slice(&k))),
            source,
            entries: BTreeMap::new(),
        };
        if vault.cipher.is_none() {
            log::warn!("vault key unavailable — saved secrets are locked");
        }
        if let (Some(bytes), Some(cipher)) = (existing, &vault.cipher) {
            match decrypt(cipher, &bytes) {
                Some(entries) => vault.entries = entries,
                None => {
                    // Wrong key or corrupted file: never overwrite it, keep the vault locked.
                    log::error!("cannot decrypt {}", vault.path.display());
                    vault.cipher = None;
                }
            }
        }
        Ok(vault)
    }

    pub fn key_in_keyring(&self) -> bool {
        self.cipher.is_some() && self.source == SRC_KEYRING
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries.get(key).map(String::as_str)
    }

    /// Empty value removes the entry. Call `persist` afterwards.
    pub fn set(&mut self, key: String, value: &str) {
        if value.is_empty() {
            self.entries.remove(&key);
        } else {
            self.entries.insert(key, value.to_string());
        }
    }

    pub fn persist(&self) -> Result<()> {
        let cipher = self.cipher.as_ref().ok_or_else(|| {
            Error::msg(tr!(
                "хранилище паролей заблокировано (нет доступа к системному keyring)",
                "password vault is locked (system keyring is not accessible)"
            ))
        })?;
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).map_err(|e| Error::msg(e.to_string()))?;
        let plain = serde_json::to_vec(&self.entries)?;
        let sealed = cipher
            .encrypt(Nonce::from_slice(&nonce), plain.as_slice())
            .map_err(|_| Error::msg("vault encryption failed"))?;
        let mut out = Vec::with_capacity(MAGIC.len() + 1 + nonce.len() + sealed.len());
        out.extend_from_slice(MAGIC);
        out.push(self.source);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&sealed);
        write_private(&self.path, &out)
    }
}

fn decrypt(cipher: &ChaCha20Poly1305, bytes: &[u8]) -> Option<BTreeMap<String, String>> {
    let body = bytes.strip_prefix(MAGIC.as_slice())?.get(1..)?;
    if body.len() < 12 {
        return None;
    }
    let (nonce, sealed) = body.split_at(12);
    let plain = cipher.decrypt(Nonce::from_slice(nonce), sealed).ok()?;
    serde_json::from_slice(&plain).ok()
}

fn random_key() -> Result<[u8; 32]> {
    let mut k = [0u8; 32];
    getrandom::fill(&mut k).map_err(|e| Error::msg(e.to_string()))?;
    Ok(k)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Option<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(out)
}

fn keyring_entry() -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()
}

fn keyring_get() -> Option<[u8; 32]> {
    from_hex(&keyring_entry()?.get_password().ok()?)
}

/// Existing key from the keyring, or a new one stored there. None = no usable keyring.
fn keyring_get_or_create() -> Option<[u8; 32]> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(hex) => from_hex(&hex),
        Err(keyring::Error::NoEntry) => {
            let key = random_key().ok()?;
            entry.set_password(&to_hex(&key)).ok()?;
            // read back: some backends silently drop writes
            (entry.get_password().ok().as_deref() == Some(to_hex(&key).as_str())).then_some(key)
        }
        Err(_) => None,
    }
}

fn read_key_file(path: &Path) -> Option<[u8; 32]> {
    from_hex(&fs::read_to_string(path).ok()?)
}

fn read_or_create_key_file(path: &Path) -> Result<[u8; 32]> {
    if let Some(k) = read_key_file(path) {
        return Ok(k);
    }
    let key = random_key()?;
    write_private(path, to_hex(&key).as_bytes())?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_with_file_key() {
        let dir = std::env::temp_dir().join(format!("adrix-vault-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let key = read_or_create_key_file(&dir.join("vault.key")).unwrap();
        let mut v = Vault {
            path: dir.join("secrets.vault"),
            cipher: Some(ChaCha20Poly1305::new(Key::from_slice(&key))),
            source: SRC_FILE,
            entries: BTreeMap::new(),
        };
        v.set("a:db".into(), "s3cret");
        v.persist().unwrap();

        let raw = fs::read(dir.join("secrets.vault")).unwrap();
        assert!(!raw.windows(6).any(|w| w == b"s3cret"), "secret stored in plain text");

        let reopened = Vault::open(&dir).unwrap();
        assert_eq!(reopened.get("a:db"), Some("s3cret"));
        fs::remove_dir_all(dir).unwrap();
    }
}
