use crate::provider::ProviderKind;

#[derive(Debug, thiserror::Error)]
pub enum DopaxError {
    #[error("provider resolution error: {0}")]
    ProviderResolution(String),
    #[error("provider {provider:?} does not support capability {capability}")]
    UnsupportedCapability {
        provider: ProviderKind,
        capability: &'static str,
    },
    #[error("feature {feature} is not implemented for provider {provider:?}")]
    NotYetImplemented {
        provider: ProviderKind,
        feature: &'static str,
    },
    #[error("configuration error: {0}")]
    Configuration(String),
    #[error("provider error: {0}")]
    Provider(String),
    #[error("transport error: {0}")]
    Transport(String),
    #[error("serialization error: {0}")]
    Serialization(String),
}

pub type Result<T> = std::result::Result<T, DopaxError>;
