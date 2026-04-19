use serde::Serialize;
use serde_json::{Value, json};

use crate::{ChatRequest, ChatResponse, DopaxError, EmbeddingRequest, EmbeddingResponse, Result};

pub fn parse_chat_request_bytes(bytes: &[u8]) -> Result<ChatRequest> {
    serde_json::from_slice(bytes).map_err(|err| DopaxError::Serialization(err.to_string()))
}

pub fn parse_embedding_request_bytes(bytes: &[u8]) -> Result<EmbeddingRequest> {
    serde_json::from_slice(bytes).map_err(|err| DopaxError::Serialization(err.to_string()))
}

pub fn render_chat_response_value(response: &ChatResponse) -> Result<Value> {
    render_value(response)
}

pub fn render_chat_response_bytes(response: &ChatResponse) -> Result<Vec<u8>> {
    render_bytes(response)
}

pub fn render_embedding_response_value(response: &EmbeddingResponse) -> Result<Value> {
    render_value(response)
}

pub fn render_embedding_response_bytes(response: &EmbeddingResponse) -> Result<Vec<u8>> {
    render_bytes(response)
}

pub fn render_error_value(error: &DopaxError) -> Value {
    match error {
        DopaxError::ProviderResolution(message) => json!({
            "error": {
                "type": "provider_resolution_error",
                "message": message,
            }
        }),
        DopaxError::UnsupportedCapability {
            provider,
            capability,
        } => json!({
            "error": {
                "type": "unsupported_capability",
                "message": error.to_string(),
                "provider": provider.as_str(),
                "capability": capability,
            }
        }),
        DopaxError::NotYetImplemented { provider, feature } => json!({
            "error": {
                "type": "not_implemented",
                "message": error.to_string(),
                "provider": provider.as_str(),
                "feature": feature,
            }
        }),
        DopaxError::Configuration(message) => json!({
            "error": {
                "type": "configuration_error",
                "message": message,
            }
        }),
        DopaxError::Provider(message) => json!({
            "error": {
                "type": "provider_error",
                "message": message,
            }
        }),
        DopaxError::Transport(message) => json!({
            "error": {
                "type": "transport_error",
                "message": message,
            }
        }),
        DopaxError::Serialization(message) => json!({
            "error": {
                "type": "serialization_error",
                "message": message,
            }
        }),
    }
}

pub fn render_error_bytes(error: &DopaxError) -> Result<Vec<u8>> {
    serde_json::to_vec(&render_error_value(error))
        .map_err(|err| DopaxError::Serialization(err.to_string()))
}

fn render_value<T: Serialize>(value: &T) -> Result<Value> {
    serde_json::to_value(value).map_err(|err| DopaxError::Serialization(err.to_string()))
}

fn render_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|err| DopaxError::Serialization(err.to_string()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{
        DopaxError, ProviderKind,
        types::{ChatResponse, EmbeddingResponse, Role, Usage},
    };

    use super::{
        parse_chat_request_bytes, render_chat_response_value, render_embedding_response_value,
        render_error_value,
    };

    #[test]
    fn parses_chat_requests_from_bytes() {
        let body = json!({
            "model": "anthropic/claude-3-7-sonnet",
            "messages": [
                { "role": "system", "content": "Be concise." },
                { "role": "user", "content": "Hello" }
            ],
            "temperature": 0.2,
            "top_p": 0.9,
            "max_tokens": 64,
            "stream": true,
            "vendor_options": {
                "response_format": { "type": "json_object" }
            }
        });

        let request = parse_chat_request_bytes(body.to_string().as_bytes()).unwrap();

        assert_eq!(request.model, "anthropic/claude-3-7-sonnet");
        assert_eq!(request.messages.len(), 2);
        assert_eq!(request.messages[0].role, Role::System);
        assert_eq!(request.top_p, Some(0.9));
        assert_eq!(
            request.vendor_options["response_format"]["type"],
            "json_object"
        );
    }

    #[test]
    fn renders_chat_responses_to_value() {
        let response = ChatResponse {
            model: "claude-3-7-sonnet".to_string(),
            content: "hello".to_string(),
            finish_reason: Some("stop".to_string()),
            provider: Some("anthropic".to_string()),
            usage: Some(Usage {
                prompt_tokens: Some(10),
                completion_tokens: Some(3),
                total_tokens: Some(13),
            }),
        };

        let value = render_chat_response_value(&response).unwrap();

        assert_eq!(value["provider"], "anthropic");
        assert_eq!(value["usage"]["total_tokens"], 13);
    }

    #[test]
    fn renders_embedding_responses_to_value() {
        let response = EmbeddingResponse {
            model: "text-embedding-004".to_string(),
            vectors: vec![vec![0.1, 0.2]],
            provider: Some("gemini".to_string()),
            usage: None,
        };

        let value = render_embedding_response_value(&response).unwrap();

        assert_eq!(value["model"], "text-embedding-004");
        let second = value["vectors"][0][1].as_f64().unwrap();
        assert!((second - 0.2).abs() < 1e-6);
    }

    #[test]
    fn renders_structured_errors() {
        let value = render_error_value(&DopaxError::UnsupportedCapability {
            provider: ProviderKind::Anthropic,
            capability: "embeddings",
        });

        assert_eq!(value["error"]["type"], "unsupported_capability");
        assert_eq!(value["error"]["provider"], "anthropic");
    }
}
