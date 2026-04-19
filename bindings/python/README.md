# Python Binding

This binding will expose the Dopax runtime to Python applications.

Planned direction:

- thin wrapper around `dopax-ffi`
- JSON-oriented request and response boundary
- native Python streaming iterator on top of FFI stream handles
- no provider logic duplicated in Python
