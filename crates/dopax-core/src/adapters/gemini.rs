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
    "reasoning_effort",
    "thinking",
];

const EMBEDDING_PARAMETERS: &[&str] = &["input", "dimensions"];

#[derive(Debug, Default)]
pub struct GeminiAdapter;

impl ProviderAdapter for GeminiAdapter {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Gemini
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

        let (system_instruction, contents) = build_gemini_contents(&request.messages);
        let mut body = Map::new();
        body.insert("contents".to_string(), Value::Array(contents));

        if let Some(system_instruction) = system_instruction {
            body.insert("system_instruction".to_string(), system_instruction);
        }

        let mut generation_config = request
            .vendor_options
            .get("generationConfig")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        if let Some(temperature) = request.temperature {
            generation_config.insert("temperature".to_string(), json!(temperature));
        }
        if let Some(top_p) = request.top_p {
            generation_config.insert("topP".to_string(), json!(top_p));
        }
        if let Some(max_tokens) = request.max_tokens {
            generation_config.insert("maxOutputTokens".to_string(), json!(max_tokens));
        }
        merge_gemini_generation_aliases(&request.vendor_options, &mut generation_config);
        if !generation_config.is_empty() {
            body.insert(
                "generationConfig".to_string(),
                Value::Object(generation_config),
            );
        }

        for (key, value) in &request.vendor_options {
            if key == "generationConfig"
                || matches!(
                    key.as_str(),
                    "candidate_count"
                        | "response_mime_type"
                        | "response_schema"
                        | "stop_sequences"
                        | "top_k"
                )
            {
                continue;
            }
            body.insert(key.clone(), value.clone());
        }

        let path = if request.stream {
            format!(
                "/v1beta/models/{}:streamGenerateContent?alt=sse",
                resolved.provider_model
            )
        } else {
            format!("/v1beta/models/{}:generateContent", resolved.provider_model)
        };

        Ok(NormalizedRequest {
            method: HttpMethod::Post,
            path,
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: Value::Object(body),
        })
    }

    fn parse_chat_response(&self, resolved: &ResolvedModel, body: &[u8]) -> Result<ChatResponse> {
        let parsed: GeminiGenerateContentResponse = serde_json::from_slice(body)
            .map_err(|err| DopaxError::Serialization(err.to_string()))?;
        let candidate = parsed
            .candidates
            .and_then(|mut candidates| candidates.drain(..).next())
            .ok_or_else(|| {
                DopaxError::Provider("gemini response did not include any candidates".to_string())
            })?;

        let content = candidate
            .content
            .parts
            .into_iter()
            .filter_map(|part| part.text)
            .collect::<Vec<_>>()
            .join("");

        Ok(ChatResponse {
            model: resolved.provider_model.clone(),
            content,
            finish_reason: normalize_finish_reason(candidate.finish_reason.as_deref()),
            provider: Some(self.kind().as_str().to_string()),
            usage: parsed.usage_metadata.map(|usage| Usage {
                prompt_tokens: usage.prompt_token_count,
                completion_tokens: usage.candidates_token_count,
                total_tokens: usage.total_token_count,
            }),
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

        let mut request_overrides = request.vendor_options.clone();
        let mut requests = Vec::with_capacity(request.input.len());
        for input in &request.input {
            let mut embedding_request = Map::new();
            embedding_request.insert(
                "model".to_string(),
                Value::String(format!("models/{}", resolved.provider_model)),
            );
            embedding_request.insert(
                "content".to_string(),
                json!({
                    "parts": [{ "text": input }],
                }),
            );
            if let Some(dimensions) = request.dimensions {
                embedding_request.insert("outputDimensionality".to_string(), json!(dimensions));
            } else if let Some(dimensions) = request_overrides.remove("dimensions") {
                embedding_request.insert("outputDimensionality".to_string(), dimensions);
            }
            for (key, value) in &request_overrides {
                embedding_request.insert(key.clone(), value.clone());
            }
            requests.push(Value::Object(embedding_request));
        }

        Ok(NormalizedRequest {
            method: HttpMethod::Post,
            path: format!(
                "/v1beta/models/{}:batchEmbedContents",
                resolved.provider_model
            ),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: json!({ "requests": requests }),
        })
    }

    fn parse_embedding_response(
        &self,
        resolved: &ResolvedModel,
        body: &[u8],
    ) -> Result<EmbeddingResponse> {
        let parsed: GeminiBatchEmbedResponse = serde_json::from_slice(body)
            .map_err(|err| DopaxError::Serialization(err.to_string()))?;

        Ok(EmbeddingResponse {
            model: resolved.provider_model.clone(),
            vectors: parsed
                .embeddings
                .into_iter()
                .map(|embedding| embedding.values)
                .collect(),
            provider: Some(self.kind().as_str().to_string()),
            usage: None,
        })
    }
}

fn build_gemini_contents(messages: &[ChatMessage]) -> (Option<Value>, Vec<Value>) {
    let mut system_parts = Vec::new();
    let mut grouped: Vec<(String, Vec<Value>)> = Vec::new();

    for message in messages {
        match message.role {
            Role::System | Role::Developer => {
                if !message.content.is_empty() {
                    system_parts.push(gemini_text_part(&message.content));
                }
            }
            Role::User | Role::Tool => push_gemini_group(&mut grouped, "user", &message.content),
            Role::Assistant => push_gemini_group(&mut grouped, "model", &message.content),
        }
    }

    let contents = if grouped.is_empty() {
        vec![json!({
            "role": "user",
            "parts": [gemini_text_part(".")],
        })]
    } else {
        grouped
            .into_iter()
            .map(|(role, parts)| {
                json!({
                    "role": role,
                    "parts": parts,
                })
            })
            .collect()
    };

    let system_instruction = if system_parts.is_empty() {
        None
    } else {
        Some(json!({ "parts": system_parts }))
    };

    (system_instruction, contents)
}

fn push_gemini_group(grouped: &mut Vec<(String, Vec<Value>)>, role: &str, text: &str) {
    if text.is_empty() {
        return;
    }

    if let Some((last_role, parts)) = grouped.last_mut()
        && last_role == role
    {
        parts.push(gemini_text_part(text));
        return;
    }

    grouped.push((role.to_string(), vec![gemini_text_part(text)]));
}

fn gemini_text_part(text: &str) -> Value {
    json!({ "text": text })
}

fn merge_gemini_generation_aliases(
    vendor_options: &Map<String, Value>,
    generation_config: &mut Map<String, Value>,
) {
    for (source, target) in [
        ("candidate_count", "candidateCount"),
        ("response_mime_type", "responseMimeType"),
        ("response_schema", "responseSchema"),
        ("stop_sequences", "stopSequences"),
        ("top_k", "topK"),
    ] {
        if let Some(value) = vendor_options.get(source) {
            generation_config.insert(target.to_string(), value.clone());
        }
    }
}

fn normalize_finish_reason(reason: Option<&str>) -> Option<String> {
    match reason {
        Some("STOP" | "FINISH_REASON_UNSPECIFIED") => Some("stop".to_string()),
        Some("MAX_TOKENS") => Some("length".to_string()),
        Some(
            "SAFETY" | "RECITATION" | "OTHER" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII"
            | "IMAGE_SAFETY",
        ) => Some("content_filter".to_string()),
        Some("MALFORMED_FUNCTION_CALL" | "TOO_MANY_TOOL_CALLS" | "MALFORMED_RESPONSE") => {
            Some("stop".to_string())
        }
        Some(other) => Some(other.to_string()),
        None => None,
    }
}

#[derive(Debug, Deserialize)]
struct GeminiGenerateContentResponse {
    #[serde(default)]
    candidates: Option<Vec<GeminiCandidate>>,
    #[serde(default, rename = "usageMetadata")]
    usage_metadata: Option<GeminiUsage>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    content: GeminiContent,
    #[serde(default, rename = "finishReason")]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiContent {
    #[serde(default)]
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Deserialize)]
struct GeminiPart {
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiUsage {
    #[serde(default, rename = "promptTokenCount")]
    prompt_token_count: Option<u32>,
    #[serde(default, rename = "candidatesTokenCount")]
    candidates_token_count: Option<u32>,
    #[serde(default, rename = "totalTokenCount")]
    total_token_count: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct GeminiBatchEmbedResponse {
    embeddings: Vec<GeminiEmbedding>,
}

#[derive(Debug, Deserialize)]
struct GeminiEmbedding {
    values: Vec<f32>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{
        adapter::ProviderAdapter,
        provider::{ProviderKind, ResolvedModel},
        types::{ChatMessage, ChatRequest, EmbeddingRequest, Role},
    };

    use super::GeminiAdapter;

    fn resolved_model(model: &str) -> ResolvedModel {
        ResolvedModel {
            raw: model.to_string(),
            provider: ProviderKind::Gemini,
            provider_model: model.to_string(),
            provider_prefix: Some("gemini".to_string()),
        }
    }

    #[test]
    fn builds_native_gemini_chat_request() {
        let adapter = GeminiAdapter;
        let request = ChatRequest {
            model: "gemini-2.0-flash".to_string(),
            messages: vec![
                ChatMessage {
                    role: Role::Developer,
                    content: "Answer in JSON.".to_string(),
                },
                ChatMessage {
                    role: Role::User,
                    content: "hello".to_string(),
                },
                ChatMessage {
                    role: Role::Assistant,
                    content: "hi".to_string(),
                },
                ChatMessage {
                    role: Role::User,
                    content: "again".to_string(),
                },
            ],
            temperature: Some(0.1),
            top_p: Some(0.7),
            max_tokens: Some(32),
            stream: true,
            vendor_options: serde_json::from_value(json!({
                "response_mime_type": "application/json"
            }))
            .unwrap(),
        };

        let normalized = adapter
            .build_chat_request(&resolved_model("gemini-2.0-flash"), &request)
            .unwrap();

        assert_eq!(
            normalized.path,
            "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            normalized.body["system_instruction"]["parts"][0]["text"],
            "Answer in JSON."
        );
        assert_eq!(normalized.body["contents"][0]["role"], "user");
        assert_eq!(normalized.body["contents"][1]["role"], "model");
        let temperature = normalized.body["generationConfig"]["temperature"]
            .as_f64()
            .unwrap();
        let top_p = normalized.body["generationConfig"]["topP"]
            .as_f64()
            .unwrap();
        assert!((temperature - 0.1).abs() < 1e-6);
        assert!((top_p - 0.7).abs() < 1e-6);
        assert_eq!(normalized.body["generationConfig"]["maxOutputTokens"], 32);
        assert_eq!(
            normalized.body["generationConfig"]["responseMimeType"],
            "application/json"
        );
    }

    #[test]
    fn parses_native_gemini_chat_response() {
        let adapter = GeminiAdapter;
        let body = json!({
            "candidates": [{
                "content": {
                    "parts": [
                        { "text": "hello " },
                        { "text": "world" }
                    ]
                },
                "finishReason": "STOP"
            }],
            "usageMetadata": {
                "promptTokenCount": 9,
                "candidatesTokenCount": 3,
                "totalTokenCount": 12
            }
        });

        let response = adapter
            .parse_chat_response(
                &resolved_model("gemini-2.0-flash"),
                body.to_string().as_bytes(),
            )
            .unwrap();

        assert_eq!(response.content, "hello world");
        assert_eq!(response.finish_reason.as_deref(), Some("stop"));
        assert_eq!(response.provider.as_deref(), Some("gemini"));
        assert_eq!(response.usage.unwrap().completion_tokens, Some(3));
    }

    #[test]
    fn builds_native_gemini_embedding_request() {
        let adapter = GeminiAdapter;
        let request = EmbeddingRequest {
            model: "text-embedding-004".to_string(),
            input: vec!["hello".to_string(), "world".to_string()],
            dimensions: Some(64),
            vendor_options: Default::default(),
        };

        let normalized = adapter
            .build_embedding_request(&resolved_model("text-embedding-004"), &request)
            .unwrap();

        assert_eq!(
            normalized.path,
            "/v1beta/models/text-embedding-004:batchEmbedContents"
        );
        assert_eq!(
            normalized.body["requests"][0]["model"],
            "models/text-embedding-004"
        );
        assert_eq!(normalized.body["requests"][0]["outputDimensionality"], 64);
        assert_eq!(
            normalized.body["requests"][1]["content"]["parts"][0]["text"],
            "world"
        );
    }

    #[test]
    fn parses_native_gemini_embedding_response() {
        let adapter = GeminiAdapter;
        let body = json!({
            "embeddings": [
                { "values": [0.1, 0.2] },
                { "values": [0.3, 0.4] }
            ]
        });

        let response = adapter
            .parse_embedding_response(
                &resolved_model("text-embedding-004"),
                body.to_string().as_bytes(),
            )
            .unwrap();

        assert_eq!(response.vectors.len(), 2);
        assert_eq!(response.vectors[0], vec![0.1, 0.2]);
        assert_eq!(response.provider.as_deref(), Some("gemini"));
    }
}
