use std::str::FromStr;

use crate::{DopaxError, Result, capabilities::Capability};

const OPENAI_COMPATIBLE_PREFIXES: &[&str] = &[
    "openai",
    "openai_compatible",
    "azure",
    "deepinfra",
    "deepseek",
    "fireworks",
    "groq",
    "lm_studio",
    "mistral",
    "ollama",
    "openrouter",
    "together",
    "vllm",
    "xai",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    OpenAiCompatible,
    Anthropic,
    Gemini,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "openai_compatible",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }

    pub fn capabilities(self) -> &'static [Capability] {
        match self {
            Self::OpenAiCompatible => &[
                Capability::Chat,
                Capability::ChatStream,
                Capability::Embeddings,
            ],
            Self::Anthropic => &[Capability::Chat, Capability::ChatStream],
            Self::Gemini => &[
                Capability::Chat,
                Capability::ChatStream,
                Capability::Embeddings,
            ],
        }
    }
}

impl FromStr for ProviderKind {
    type Err = DopaxError;

    fn from_str(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "openai_compatible" | "openai-compatible" | "openai_like" | "openai-like"
            | "openai" => Ok(Self::OpenAiCompatible),
            "anthropic" => Ok(Self::Anthropic),
            "gemini" => Ok(Self::Gemini),
            other => Err(DopaxError::ProviderResolution(format!(
                "unknown provider kind: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ResolvedModel {
    pub raw: String,
    pub provider: ProviderKind,
    pub provider_model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_prefix: Option<String>,
}

pub fn resolve_model(model: &str, hint: Option<ProviderKind>) -> Result<ResolvedModel> {
    let raw = model.trim();
    if raw.is_empty() {
        return Err(DopaxError::ProviderResolution(
            "model must not be empty".to_string(),
        ));
    }

    if let Some((prefix, provider_model)) = raw.split_once('/') {
        if let Some(provider) = provider_from_prefix(prefix) {
            if let Some(expected) = hint {
                if expected != provider {
                    return Err(DopaxError::ProviderResolution(format!(
                        "model prefix '{prefix}' resolved to {}, but client is pinned to {}",
                        provider.as_str(),
                        expected.as_str()
                    )));
                }
            }

            return Ok(ResolvedModel {
                raw: raw.to_string(),
                provider,
                provider_model: provider_model.to_string(),
                provider_prefix: Some(prefix.to_string()),
            });
        }

        if let Some(provider) = hint {
            return Ok(ResolvedModel {
                raw: raw.to_string(),
                provider,
                provider_model: raw.to_string(),
                provider_prefix: None,
            });
        }

        return Err(DopaxError::ProviderResolution(format!(
            "unknown provider prefix '{prefix}' in model '{raw}'"
        )));
    }

    let provider = hint.unwrap_or_else(|| default_provider_for_model(raw));
    Ok(ResolvedModel {
        raw: raw.to_string(),
        provider,
        provider_model: raw.to_string(),
        provider_prefix: None,
    })
}

pub fn provider_from_prefix(prefix: &str) -> Option<ProviderKind> {
    let normalized = prefix.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "anthropic" => Some(ProviderKind::Anthropic),
        "gemini" => Some(ProviderKind::Gemini),
        other if OPENAI_COMPATIBLE_PREFIXES.contains(&other) => {
            Some(ProviderKind::OpenAiCompatible)
        }
        _ => None,
    }
}

fn default_provider_for_model(model: &str) -> ProviderKind {
    let normalized = model.trim().to_ascii_lowercase();
    if normalized.starts_with("claude") {
        ProviderKind::Anthropic
    } else if normalized.starts_with("gemini") {
        ProviderKind::Gemini
    } else {
        ProviderKind::OpenAiCompatible
    }
}

#[cfg(test)]
mod tests {
    use super::{ProviderKind, resolve_model};

    #[test]
    fn resolves_prefixed_openai_compatible_models() {
        let resolved = resolve_model("deepseek/deepseek-chat", None).unwrap();
        assert_eq!(resolved.provider, ProviderKind::OpenAiCompatible);
        assert_eq!(resolved.provider_model, "deepseek-chat");
        assert_eq!(resolved.provider_prefix.as_deref(), Some("deepseek"));
    }

    #[test]
    fn resolves_native_prefixes() {
        let anthropic = resolve_model("anthropic/claude-3-7-sonnet", None).unwrap();
        assert_eq!(anthropic.provider, ProviderKind::Anthropic);
        assert_eq!(anthropic.provider_model, "claude-3-7-sonnet");

        let gemini = resolve_model("gemini/gemini-2.0-flash", None).unwrap();
        assert_eq!(gemini.provider, ProviderKind::Gemini);
        assert_eq!(gemini.provider_model, "gemini-2.0-flash");
    }

    #[test]
    fn defaults_unprefixed_models() {
        let gpt = resolve_model("gpt-4o-mini", None).unwrap();
        assert_eq!(gpt.provider, ProviderKind::OpenAiCompatible);

        let claude = resolve_model("claude-sonnet-4-5", None).unwrap();
        assert_eq!(claude.provider, ProviderKind::Anthropic);
    }

    #[test]
    fn rejects_provider_mismatch_against_hint() {
        let err =
            resolve_model("anthropic/claude-3-7-sonnet", Some(ProviderKind::Gemini)).unwrap_err();
        assert!(err.to_string().contains("client is pinned"));
    }
}
