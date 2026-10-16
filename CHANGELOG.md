# Changes

## 0.1.5-stable.1

- Synchronize TTL-only changes; use automatic TTL for proxied Cloudflare records.
- Replace records and state through temporary files, preserving existing files on write failure.
- Coalesce overlapping manual and scheduled synchronization requests.
- Patch the build-only brace-expansion dependency to 2.1.7 and audit development dependencies in CI.
- Publish complete draft releases before applying GitHub's immutable release protection.

## 0.1.4-stable.1

- Establish a separately maintained Stable fork from yunjianj/Komari-DDNS@v0.1.3.
- Require confirmed node online status and stop DNS synchronization after status-query failure.
- Lock independent build dependencies, validate deterministic release packages and retain original plugin identity.
