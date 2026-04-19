use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{
    DopaxError, Result,
    adapter::{HttpMethod, NormalizedRequest, ProviderAdapter},
    provider::{ProviderKind, ResolvedModel},
    types::{ChatMessage, ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse, Usage},
};

const CHAT_PARAMETERS: &[&str] = &[
    "messages",
    "temperature",
    "max_tokens",
    "max_completion_tokens",
    "stream",
    "stream_options",
    "response_format",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "top_p",
    "stop",
    "presence_penalty",
    "frequency_penalty",
];

const EMBEDDING_PARAMETERS: &[&str] = &["input", "dimensions", "encoding_format", "user"];

#[derive(Debug, Default)]
pub struct OpenAiCompatibleAdapter;

impl ProviderAdapter for OpenAiCompatibleAdapter {
    fn kind(&self) -> ProviderKind {
        ProviderKind::OpenAiCompatible
    }

    fn supported_chat_parameters(&self, _resolved: &ResolvedModel) -> &'static [&'static str] {
        CHAT_PARAMETERS
    }

    fn supported_embedding_parameters(&self, _resolved: &ResolvedModel) -> &'static [&'static str] {
        EMBEDDING_PARAMETERS
    }

    fn build_chat_request(
        &self,
        resolved: &ResolvedModel,
        request: &ChatRequest,
    ) -> Result<NormalizedRequest> {
        if resolved.provider != self.kind() {
            return Err(DopaxError::Configuration(format!(
                "resolved provider {} does not match adapter {}",
                resolved.provider.as_str(),
                self.kind().as_str()
            )));
        }

        let mut body = Map::new();
        body.insert(
            "model".to_string(),
            Value::String(resolved.provider_model.clone()),
        );
        body.insert(
            "messages".to_string(),
            Value::Array(
                request
                    .messages
                    .iter()
                    .map(serialize_message)
                    .collect::<Vec<_>>(),
            ),
        );
        if let Some(temperature) = request.temperature {
            body.insert("temperature".to_string(), json!(temperature));
        }
        if let Some(top_p) = request.top_p {
            body.insert("top_p".to_string(), json!(top_p));
        }
        if let Some(max_tokens) = request.max_tokens {
            body.insert("max_tokens".to_string(), json!(max_tokens));
        }
        if request.stream {
            body.insert("stream".to_string(), Value::Bool(true));
        }
        body.extend(request.vendor_options.clone());

        Ok(NormalizedRequest {
            method: HttpMethod::Post,
            path: "/v1/chat/completions".to_string(),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: Value::Object(body),
        })
    }

    fn parse_chat_response(&self, resolved: &ResolvedModel, body: &[u8]) -> Result<ChatResponse> {
        let parsed: OpenAiChatCompletion = serde_json::from_slice(body)
            .map_err(|err| DopaxError::Serialization(err.to_string()))?;
        let choice = parsed
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| DopaxError::Provider("missing completion choice".to_string()))?;

        Ok(ChatResponse {
            model: parsed
                .model
                .unwrap_or_else(|| resolved.provider_model.clone()),
            content: choice.message.and_then(|m| m.content).unwrap_or_default(),
            finish_reason: choice.finish_reason,
            provider: resolved.provider_prefix.clone(),
            usage: parsed.usage.map(parse_openai_usage),
        })
    }

    fn build_embedding_request(
        &self,
        resolved: &ResolvedModel,
        request: &EmbeddingRequest,
    ) -> Result<NormalizedRequest> {
        if resolved.provider != self.kind() {
            return Err(DopaxError::Configuration(format!(
                "resolved provider {} does not match adapter {}",
                resolved.provider.as_str(),
                self.kind().as_str()
            )));
        }

        let mut body = Map::new();
        body.insert(
            "model".to_string(),
            Value::String(resolved.provider_model.clone()),
        );
        body.insert("input".to_string(), json!(request.input));
        if let Some(dimensions) = request.dimensions {
            body.insert("dimensions".to_string(), json!(dimensions));
        }
        body.extend(request.vendor_options.clone());

        Ok(NormalizedRequest {
            method: HttpMethod::Post,
            path: "/v1/embeddings".to_string(),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: Value::Object(body),
        })
    }

    fn parse_embedding_response(
        &self,
        resolved: &ResolvedModel,
        body: &[u8],
    ) -> Result<EmbeddingResponse> {
        let parsed: OpenAiEmbeddingEnvelope = serde_json::from_slice(body)
            .map_err(|err| DopaxError::Serialization(err.to_string()))?;

        Ok(EmbeddingResponse {
            model: parsed
                .model
                .unwrap_or_else(|| resolved.provider_model.clone()),
            vectors: parsed.data.into_iter().map(|item| item.embedding).collect(),
            provider: resolved.provider_prefix.clone(),
            usage: parsed.usage.map(parse_openai_usage),
        })
    }
}

fn parse_openai_usage(usage: OpenAiUsage) -> Usage {
    Usage {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
    }
}

fn serialize_message(message: &ChatMessage) -> Value {
    json!({
        "role": message.role,
        "content": message.content,
    })
}

#[derive(Debug, Deserialize)]
struct OpenAiChatCompletion {
    #[serde(default)]
    model: Option<String>,
    choices: Vec<OpenAiChoice>,
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    #[serde(default)]
    message: Option<OpenAiMessage>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiMessage {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbeddingEnvelope {
    #[serde(default)]
    model: Option<String>,
    data: Vec<OpenAiEmbeddingItem>,
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbeddingItem {
    embedding: Vec<f32>,
}

#[derive(Debug, Deserialize)]
struct OpenAiUsage {
    #[serde(default)]
    prompt_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens: Option<u32>,
    #[serde(default)]
    total_tokens: Option<u32>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{
        adapter::ProviderAdapter,
        provider::{ProviderKind, ResolvedModel},
        types::{ChatMessage, ChatRequest, EmbeddingRequest, Role},
    };

    use super::OpenAiCompatibleAdapter;

    fn resolved_model(model: &str, provider_prefix: Option<&str>) -> ResolvedModel {
        ResolvedModel {
            raw: model.to_string(),
            provider: ProviderKind::OpenAiCompatible,
            provider_model: model.to_string(),
            provider_prefix: provider_prefix.map(str::to_string),
        }
    }

    #[test]
    fn builds_chat_requests_in_openai_shape() {
        let adapter = OpenAiCompatibleAdapter;
        let request = ChatRequest {
            model: "gpt-4o-mini".to_string(),
            messages: vec![ChatMessage {
                role: Role::User,
                content: "Hello".to_string(),
            }],
            temperature: Some(0.3),
            top_p: Some(0.8),
            max_tokens: Some(42),
            stream: true,
            vendor_options: serde_json::from_value(json!({
                "response_format": { "type": "json_object" }
            }))
            .unwrap(),
        };

        let normalized = adapter
            .build_chat_request(&resolved_model("gpt-4o-mini", Some("openai")), &request)
            .unwrap();

        assert_eq!(normalized.path, "/v1/chat/completions");
        assert_eq!(normalized.body["model"], "gpt-4o-mini");
        assert_eq!(normalized.body["messages"][0]["role"], "user");
        assert_eq!(normalized.body["stream"], true);
        let top_p = normalized.body["top_p"].as_f64().unwrap();
        assert!((top_p - 0.8).abs() < 1e-6);
        assert_eq!(normalized.body["response_format"]["type"], "json_object");
    }

    #[test]
    fn parses_openai_chat_responses() {
        let adapter = OpenAiCompatibleAdapter;
        let body = json!({
            "model": "gpt-4o-mini",
            "choices": [{
                "message": { "content": "hello back" },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 11,
                "completion_tokens": 4,
                "total_tokens": 15
            }
        });

        let response = adapter
            .parse_chat_response(
                &resolved_model("gpt-4o-mini", Some("openai")),
                body.to_string().as_bytes(),
            )
            .unwrap();

        assert_eq!(response.content, "hello back");
        assert_eq!(response.finish_reason.as_deref(), Some("stop"));
        assert_eq!(response.usage.unwrap().total_tokens, Some(15));
    }

    #[test]
    fn builds_embedding_requests_in_openai_shape() {
        let adapter = OpenAiCompatibleAdapter;
        let request = EmbeddingRequest {
            model: "text-embedding-3-small".to_string(),
            input: vec!["hello".to_string(), "world".to_string()],
            dimensions: Some(64),
            vendor_options: Default::default(),
        };

        let normalized = adapter
            .build_embedding_request(
                &resolved_model("text-embedding-3-small", Some("openai")),
                &request,
            )
            .unwrap();

        assert_eq!(normalized.path, "/v1/embeddings");
        assert_eq!(normalized.body["input"][0], "hello");
        assert_eq!(normalized.body["dimensions"], 64);
    }

    #[test]
    fn parses_openai_embedding_responses() {
        let adapter = OpenAiCompatibleAdapter;
        let body = json!({
            "model": "text-embedding-3-small",
            "data": [
                { "embedding": [0.1, 0.2] },
                { "embedding": [0.3, 0.4] }
            ],
            "usage": {
                "prompt_tokens": 6,
                "total_tokens": 6
            }
        });

        let response = adapter
            .parse_embedding_response(
                &resolved_model("text-embedding-3-small", Some("openai")),
                body.to_string().as_bytes(),
            )
            .unwrap();

        assert_eq!(response.vectors.len(), 2);
        assert_eq!(response.vectors[0], vec![0.1, 0.2]);
        assert_eq!(response.usage.unwrap().prompt_tokens, Some(6));
    }
}
