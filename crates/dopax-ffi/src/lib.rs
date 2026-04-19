pub const ABI_VERSION: &str = "dopax-ffi/0.1";

pub fn abi_version() -> &'static str {
    ABI_VERSION
}

pub fn core_version() -> &'static str {
    dopax_core::VERSION
}
