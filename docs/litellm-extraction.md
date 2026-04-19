# LiteLLM Extraction Notes

The goal is to learn from LiteLLM's SDK internals without inheriting its gateway sprawl.

## Concepts We Are Reusing

- LiteLLM `get_llm_provider()`
  becomes Dopax `resolve_model()`
- LiteLLM `BaseConfig`
  becomes Dopax `ProviderAdapter`
- LiteLLM `get_supported_openai_params()`
  becomes adapter-level supported parameter metadata
- LiteLLM `openai_like` handler pattern
  becomes the first concrete Dopax adapter family

## Concepts We Are Not Copying

- giant `main.py` dispatch tree
- proxy auth and management types
- router, budget, and fallback runtime
- logging callback fanout
- secret manager plumbing inside provider adapters

## Mapping

| LiteLLM | Dopax |
|---------|-------|
| `main.py` dispatch | small client + adapter boundary |
| `get_llm_provider()` | `provider::resolve_model()` |
| provider transformation classes | adapter implementations |
| `get_supported_openai_params()` | `supported_*_parameters()` |
| proxy/gateway runtime | out of scope |
