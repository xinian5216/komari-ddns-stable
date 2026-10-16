# Upstream and maintenance boundary

Original: https://github.com/yunjianj/Komari-DDNS

Baseline: v0.1.3 (fed6972366fc8632be8725960083b365cfaec812). Original authorship and Git history are preserved.

This repository is maintained by xinian5216 for Komari Stable. It is not an official upstream release.

Changes: stop DNS updates when node online status is unavailable; synchronize TTL changes, save records and state through temporary files, and coalesce overlapping sync requests. Retain records, routes and configuration.

Build tooling: published plugin SDK/dev 1.4.3, locked dependencies, deterministic ZIP packaging, separate CI and explicit releases. No automatic upstream merges or releases.

Runtime minimum remains >=1.4.0. Do not import the Passkey main branch requiring Komari 1.6.0 into this 1.5.0-compatible line.

Versioning: the current market UI compares only numeric major/minor/patch. Increment the numeric patch for each subsequent maintenance release, rather than only changing the stable suffix. Published tags and assets must never be overwritten.
