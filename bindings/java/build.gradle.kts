plugins {
    `java-library`
}

group = "dev.dopax"
version = "0.1.0"

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}
