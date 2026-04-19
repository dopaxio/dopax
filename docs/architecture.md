# Dopax Architecture

`dopax` is designed around three layers:

1. `dopax-core`
   Common request and response types, provider capability metadata, error mapping,
   transport abstractions, and request/response transformations.

2. `dopax-ffi`
   A stable ABI-oriented layer that will eventually expose JSON-oriented calls and
   streaming handles to non-Rust bindings.

3. Language bindings
   Thin wrappers for Python, Node.js / TypeScript, Java, Go, and C#.

## Design Direction

- Prefer a small common core over a giant universal SDK.
- Normalize the 60-80% that providers genuinely share.
- Preserve native features through explicit provider-specific fields.
- Treat OpenAI-compatible APIs as one adapter family, not the whole world.

## Binding Strategy

- Python: package wrapper over the shared ABI
- Node.js / TypeScript: package wrapper over the shared ABI
- Java: JVM wrapper over the shared ABI
- Go: cgo wrapper over the shared ABI
- C#: .NET wrapper over the shared ABI

All bindings should stay thin and avoid re-implementing provider logic.
