//! Language of core messages (errors reach the UI as text). Set from settings.json / `save_settings`.

use std::sync::atomic::{AtomicBool, Ordering};

static RU: AtomicBool = AtomicBool::new(false);

pub fn set(lang: &str) {
    RU.store(lang.starts_with("ru"), Ordering::Relaxed);
}

pub fn is_ru() -> bool {
    RU.load(Ordering::Relaxed)
}

/// `tr!("<ru> {x}", "<en> {x}")` — format! with the template picked by the current language.
#[macro_export]
macro_rules! tr {
    ($ru:literal, $en:literal $(, $arg:expr)* $(,)?) => {
        if $crate::i18n::is_ru() { format!($ru $(, $arg)*) } else { format!($en $(, $arg)*) }
    };
}
