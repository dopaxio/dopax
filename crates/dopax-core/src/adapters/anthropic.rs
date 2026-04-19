use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{
    DopaxError, Result,
    adapter::{HttpMethod, NormalizedRequest, ProviderAdapter},
    provider::{ProviderKind, ResolvedModel},
    types::{
        ChatMessage, ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse, Role, Usage,
    },
};

const CHAT_PARAMETERS: &[&str] = &[
    "messages",
    "temperature",
    "top_p",
    "max_tokens",
    "stream",
    "tools",
    "tool_choice",
    "response_format",
    "thinking",
    "reasoning_effort",
];
const DEFAULT_ANTHROPIC_MAX_TOKENS: u32 = 4096;

#[derive(Debug, Default)]
pub struct AnthropicAdapter;

impl ProviderAdapter for AnthropicAdapter {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Anthropic
    }

    fn supported_chat_parameters(&self, _resolved: &ResolvedModel) -> &'static [&'static str] {
        CHAT_PARAMETERS
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

        let (system_blocks, messages) = build_anthropic_messages(&request.messages)?;
        if messages.is_empty() {
            return Err(DopaxError::Configuration(
                "anthropic requests require at least one non-system message".to_string(),
            ));
        }

        let mut body = Map::new();
        body.insert(
            "model".to_string(),
            Value::String(resolved.provider_model.clone()),
        );
        body.insert("messages".to_string(), Value::Array(messages));
        body.insert(
            "max_tokens".to_string(),
            json!(request.max_tokens.unwrap_or(DEFAULT_ANTHROPIC_MAX_TOKENS)),
        );
        if !system_blocks.is_empty() {
            body.insert("system".to_string(), Value::Array(system_blocks));
        }
        if let Some(temperature) = request.temperature {
            body.insert("temperature".to_string(), json!(temperature));
        }
        if let Some(top_p) = request.top_p {
            body.insert("top_p".to_string(), json!(top_p));
        }
        if request.stream {
            body.insert("stream".to_string(), Value::Bool(true));
        }
        body.extend(request.vendor_options.clone());

        Ok(NormalizedRequest {
            method: HttpMethod::Post,
            path: "/v1/messages".to_string(),
            headers: vec![
                ("content-type".to_string(), "application/json".to_string()),
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
            ],
            body: Value::Object(body),
        })
    }

    fn parse_chat_response(&self, resolved: &ResolvedModel, body: &[u8]) -> Result<ChatResponse> {
        let parsed: AnthropicChatResponse = serde_json::from_slice(body)
            .map_err(|err| DopaxError::Serialization(err.to_string()))?;

        let content = parsed
            .content
            .into_iter()
            .filter(|block| block.kind == "text")
            .filter_map(|block| block.text)
            .collect::<Vec<_>>()
            .join("");

        Ok(ChatResponse {
            model: parsed
                .model
                .unwrap_or_else(|| resolved.provider_model.clone()),
            content,
            finish_reason: normalize_finish_reason(parsed.stop_reason.as_deref()),
            provider: Some(self.kind().as_str().to_string()),
            usage: parsed.usage.map(|usage| Usage {
                prompt_tokens: Some(usage.input_tokens),
                completion_tokens: Some(usage.output_tokens),
                total_tokens: Some(usage.input_tokens + usage.output_tokens),
            }),
        })
    }

    fn build_embedding_request(
        &self,
        _resolved: &ResolvedModel,
        _request: &EmbeddingRequest,
    ) -> Result<NormalizedRequest> {
        Err(DopaxError::UnsupportedCapability {
            provider: self.kind(),
            capability: "embeddings",
        })
    }

    fn parse_embedding_response(
        &self,
        _resolved: &ResolvedModel,
        _body: &[u8],
    ) -> Result<EmbeddingResponse> {
        Err(DopaxError::UnsupportedCapability {
            provider: self.kind(),
            capability: "embeddings",
        })
    }
}

fn build_anthropic_messages(messages: &[ChatMessage]) -> Result<(Vec<Value>, Vec<Value>)> {
    let mut system_blocks = Vec::new();
    let mut grouped: Vec<(String, Vec<Value>)> = Vec::new();

    for message in messages {
        match message.role {
            Role::System | Role::Developer => {
                if !message.content.is_empty() {
                    system_blocks.push(text_block(&message.content));
                }
            }
            Role::User | Role::Tool => push_grouped_text(&mut grouped, "user", &message.content),
            Role::Assistant => push_grouped_text(&mut grouped, "assistant", &message.content),
        }
    }

    let anthropic_messages = grouped
        .into_iter()
        .map(|(role, content)| {
            json!({
                "role": role,
                "content": content,
            })
        })
        .collect();

    Ok((system_blocks, anthropic_messages))
}

fn push_grouped_text(grouped: &mut Vec<(String, Vec<Value>)>, role: &str, text: &str) {
    if text.is_empty() {
        return;
    }

    if let Some((last_role, content)) = grouped.last_mut()
        && last_role == role
    {
        content.push(text_block(text));
        return;
    }

    grouped.push((role.to_string(), vec![text_block(text)]));
}

fn text_block(text: &str) -> Value {
    json!({
        "type": "text",
        "text": text,
    })
}

fn normalize_finish_reason(reason: Option<&str>) -> Option<String> {
    match reason {
        Some("stop_sequence" | "end_turn") => Some("stop".to_string()),
        Some("max_tokens" | "compaction") => Some("length".to_string()),
        Some("tool_use") => Some("tool_calls".to_string()),
        Some(other) => Some(other.to_string()),
        None => None,
    }
}

#[derive(Debug, Deserialize)]
struct AnthropicChatResponse {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    content: Vec<AnthropicContentBlock>,
    #[serde(default)]
    stop_reason: Option<String>,
    #[serde(default)]
    usage: Option<AnthropicUsage>,
}

#[derive(Debug, Deserialize)]
struct AnthropicContentBlock {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnthropicUsage {
    input_tokens: u32,
    output_tokens: u32,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{
        adapter::ProviderAdapter,
        provider::{ProviderKind, ResolvedModel},
        types::{ChatMessage, ChatRequest, Role},
    };

    use super::AnthropicAdapter;

    fn resolved_model(model: &str) -> ResolvedModel {
        ResolvedModel {
            raw: model.to_string(),
            provider: ProviderKind::Anthropic,
            provider_model: model.to_string(),
            provider_prefix: Some("anthropic".to_string()),
        }
    }

    #[test]
    fn builds_native_anthropic_chat_request() {
        let adapter = AnthropicAdapter;
        let request = ChatRequest {
            model: "claude-3-7-sonnet".to_string(),
            messages: vec![
                ChatMessage {
                    role: Role::System,
                    content: "You are concise.".to_string(),
                },
                ChatMessage {
                    role: Role::User,
                    content: "hello".to_string(),
                },
                ChatMessage {
                    role: Role::User,
                    content: "again".to_string(),
                },
            ],
            temperature: Some(0.2),
            top_p: Some(0.9),
            max_tokens: None,
            stream: true,
            vendor_options: Default::default(),
        };

        let normalized = adapter
            .build_chat_request(&resolved_model("claude-3-7-sonnet"), &request)
            .unwrap();

        assert_eq!(normalized.path, "/v1/messages");
        assert_eq!(normalized.body["model"], "claude-3-7-sonnet");
        assert_eq!(normalized.body["system"][0]["text"], "You are concise.");
        assert_eq!(normalized.body["messages"][0]["role"], "user");
        assert_eq!(
            normalized.body["messages"][0]["content"][0]["text"],
            "hello"
        );
        assert_eq!(
            normalized.body["messages"][0]["content"][1]["text"],
            "again"
        );
        assert_eq!(normalized.body["max_tokens"], 4096);
        assert_eq!(normalized.body["stream"], true);
        let top_p = normalized.body["top_p"].as_f64().unwrap();
        assert!((top_p - 0.9).abs() < 1e-6);
    }

    #[test]
    fn parses_native_anthropic_chat_response() {
        let adapter = AnthropicAdapter;
        let body = json!({
            "model": "claude-3-7-sonnet",
            "content": [
                { "type": "text", "text": "hello "},
                { "type": "text", "text": "world"}
            ],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 12,
                "output_tokens": 5
            }
        });

        let response = adapter
            .parse_chat_response(
                &resolved_model("claude-3-7-sonnet"),
                body.to_string().as_bytes(),
            )
            .unwrap();

        assert_eq!(response.content, "hello world");
        assert_eq!(response.finish_reason.as_deref(), Some("stop"));
        assert_eq!(response.provider.as_deref(), Some("anthropic"));
        assert_eq!(response.usage.unwrap().total_tokens, Some(17));
    }
}
