use crate::{
    Capability, DopaxError, Result,
    adapter::{NormalizedRequest, ProviderAdapter},
    adapters::builtin_adapter,
    json_api,
    provider::{ProviderKind, ResolvedModel, resolve_model},
    types::{ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse},
};
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct ClientConfig {
    pub provider: ProviderKind,
    pub endpoint: String,
    pub api_key: Option<String>,
}

impl ClientConfig {
    pub fn new(provider: ProviderKind, endpoint: impl Into<String>) -> Self {
        Self {
            provider,
            endpoint: endpoint.into(),
            api_key: None,
        }
    }
}

pub struct DopaxClient {
    config: ClientConfig,
    adapter: Box<dyn ProviderAdapter>,
}

impl DopaxClient {
    pub fn new(config: ClientConfig) -> Result<Self> {
        if config.endpoint.trim().is_empty() {
            return Err(DopaxError::Configuration(
                "endpoint must not be empty".to_string(),
            ));
        }

        let adapter = builtin_adapter(config.provider);
        Ok(Self { config, adapter })
    }

    pub fn provider(&self) -> ProviderKind {
        self.config.provider
    }

    pub fn endpoint(&self) -> &str {
        &self.config.endpoint
    }

    pub fn supports(&self, capability: Capability) -> bool {
        self.adapter.capabilities().contains(&capability)
    }

    pub fn resolve_model(&self, model: &str) -> Result<ResolvedModel> {
        resolve_model(model, Some(self.config.provider))
    }

    pub fn supported_chat_parameters(&self, model: &str) -> Result<&'static [&'static str]> {
        let resolved = self.resolve_model(model)?;
        Ok(self.adapter.supported_chat_parameters(&resolved))
    }

    pub fn supported_embedding_parameters(&self, model: &str) -> Result<&'static [&'static str]> {
        let resolved = self.resolve_model(model)?;
        Ok(self.adapter.supported_embedding_parameters(&resolved))
    }

    pub fn build_chat_request(&self, request: &ChatRequest) -> Result<NormalizedRequest> {
        let resolved = self.resolve_model(&request.model)?;
        self.adapter.build_chat_request(&resolved, request)
    }

    pub fn build_chat_request_from_json(&self, body: &[u8]) -> Result<NormalizedRequest> {
        let request = json_api::parse_chat_request_bytes(body)?;
        self.build_chat_request(&request)
    }

    pub fn parse_chat_response(&self, model: &str, body: &[u8]) -> Result<ChatResponse> {
        let resolved = self.resolve_model(model)?;
        self.adapter.parse_chat_response(&resolved, body)
    }

    pub fn parse_chat_response_as_json(&self, model: &str, body: &[u8]) -> Result<Value> {
        let response = self.parse_chat_response(model, body)?;
        json_api::render_chat_response_value(&response)
    }

    pub fn build_embedding_request(&self, request: &EmbeddingRequest) -> Result<NormalizedRequest> {
        let resolved = self.resolve_model(&request.model)?;
        self.adapter.build_embedding_request(&resolved, request)
    }

    pub fn build_embedding_request_from_json(&self, body: &[u8]) -> Result<NormalizedRequest> {
        let request = json_api::parse_embedding_request_bytes(body)?;
        self.build_embedding_request(&request)
    }

    pub fn parse_embedding_response(&self, model: &str, body: &[u8]) -> Result<EmbeddingResponse> {
        let resolved = self.resolve_model(model)?;
        self.adapter.parse_embedding_response(&resolved, body)
    }

    pub fn parse_embedding_response_as_json(&self, model: &str, body: &[u8]) -> Result<Value> {
        let response = self.parse_embedding_response(model, body)?;
        json_api::render_embedding_response_value(&response)
    }
}

impl std::fmt::Debug for DopaxClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DopaxClient")
            .field("provider", &self.config.provider)
            .field("endpoint", &self.config.endpoint)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{
        ProviderKind,
        types::{ChatMessage, ChatRequest, Role},
    };

    use super::{ClientConfig, DopaxClient};

    #[test]
    fn client_builds_openai_compatible_requests() {
        let client = DopaxClient::new(ClientConfig::new(
            ProviderKind::OpenAiCompatible,
            "https://api.example.com",
        ))
        .unwrap();

        let request = ChatRequest {
            model: "gpt-4o-mini".to_string(),
            messages: vec![ChatMessage {
                role: Role::User,
                content: "hi".to_string(),
            }],
            temperature: None,
            top_p: None,
            max_tokens: None,
            stream: false,
            vendor_options: Default::default(),
        };

        let normalized = client.build_chat_request(&request).unwrap();
        assert_eq!(normalized.path, "/v1/chat/completions");
        assert_eq!(normalized.body["model"], "gpt-4o-mini");
    }

    #[test]
    fn client_builds_requests_from_json() {
        let client = DopaxClient::new(ClientConfig::new(
            ProviderKind::Gemini,
            "https://generativelanguage.googleapis.com",
        ))
        .unwrap();

        let body = json!({
            "model": "gemini-2.0-flash",
            "messages": [
                { "role": "developer", "content": "Return JSON." },
                { "role": "user", "content": "hello" }
            ],
            "temperature": 0.1,
            "top_p": 0.8,
            "max_tokens": 32,
            "stream": false,
            "vendor_options": {
                "response_mime_type": "application/json"
            }
        });

        let normalized = client
            .build_chat_request_from_json(body.to_string().as_bytes())
            .unwrap();

        assert_eq!(
            normalized.path,
            "/v1beta/models/gemini-2.0-flash:generateContent"
        );
        assert_eq!(
            normalized.body["generationConfig"]["responseMimeType"],
            "application/json"
        );
    }

    #[test]
    fn client_parses_responses_as_json() {
        let client = DopaxClient::new(ClientConfig::new(
            ProviderKind::Anthropic,
            "https://api.anthropic.com",
        ))
        .unwrap();

        let body = json!({
            "model": "claude-3-7-sonnet",
            "content": [
                { "type": "text", "text": "hello world" }
            ],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 10,
                "output_tokens": 2
            }
        });

        let value = client
            .parse_chat_response_as_json("claude-3-7-sonnet", body.to_string().as_bytes())
            .unwrap();

        assert_eq!(value["provider"], "anthropic");
        assert_eq!(value["finish_reason"], "stop");
        assert_eq!(value["usage"]["total_tokens"], 12);
    }
}
