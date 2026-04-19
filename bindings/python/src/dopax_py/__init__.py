"""Python binding skeleton for dopax."""

__all__ = ["__version__", "abi_version"]

__version__ = "0.1.0"


def abi_version() -> str:
    return "dopax-ffi/0.1"
