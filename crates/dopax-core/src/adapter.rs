use serde_json::Value;

use crate::{
    Result,
    capabilities::Capability,
    provider::{ProviderKind, ResolvedModel},
    types::{ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Post,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedRequest {
    pub method: HttpMethod,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

pub trait ProviderAdapter: Send + Sync {
    fn kind(&self) -> ProviderKind;

    fn capabilities(&self) -> &'static [Capability] {
        self.kind().capabilities()
    }

    fn supported_chat_parameters(&self, resolved: &ResolvedModel) -> &'static [&'static str];

    fn supported_embedding_parameters(&self, _resolved: &ResolvedModel) -> &'static [&'static str] {
        &[]
    }

    fn build_chat_request(
        &self,
        resolved: &ResolvedModel,
        request: &ChatRequest,
    ) -> Result<NormalizedRequest>;

    fn parse_chat_response(&self, resolved: &ResolvedModel, body: &[u8]) -> Result<ChatResponse>;

    fn build_embedding_request(
        &self,
        resolved: &ResolvedModel,
        request: &EmbeddingRequest,
    ) -> Result<NormalizedRequest>;

    fn parse_embedding_response(
        &self,
        resolved: &ResolvedModel,
        body: &[u8],
    ) -> Result<EmbeddingResponse>;
}
