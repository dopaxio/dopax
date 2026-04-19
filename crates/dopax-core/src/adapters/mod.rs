mod anthropic;
mod gemini;
mod openai_compatible;

use crate::{adapter::ProviderAdapter, provider::ProviderKind};

pub use anthropic::AnthropicAdapter;
pub use gemini::GeminiAdapter;
pub use openai_compatible::OpenAiCompatibleAdapter;

pub fn builtin_adapter(kind: ProviderKind) -> Box<dyn ProviderAdapter> {
    match kind {
        ProviderKind::OpenAiCompatible => Box::new(OpenAiCompatibleAdapter),
        ProviderKind::Anthropic => Box::new(AnthropicAdapter),
        ProviderKind::Gemini => Box::new(GeminiAdapter),
    }
}
