pub mod adapter;
pub mod adapters;
pub mod capabilities;
pub mod client;
pub mod error;
pub mod json_api;
pub mod provider;
pub mod types;

pub use adapter::{HttpMethod, NormalizedRequest, ProviderAdapter};
pub use capabilities::Capability;
pub use client::{ClientConfig, DopaxClient};
pub use error::{DopaxError, Result};
pub use provider::{ProviderKind, ResolvedModel, provider_from_prefix, resolve_model};
pub use types::{
    ChatChunk, ChatMessage, ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse, Role,
    Usage, VendorOptions,
};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
