# Dopax Bindings

This directory contains language-specific wrappers around the shared Dopax core.

Current first-class targets:

- Python
- Node.js / TypeScript
- Java
- Go
- C#

The long-term rule is simple:

- provider logic lives in Rust
- ABI translation lives in `dopax-ffi`
- language bindings stay thin
