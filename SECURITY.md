# Security and releases

Report vulnerabilities privately to the repository owner. Never post live credentials or private deployment details in public issues.

Both upstream plugins need administrator-level system RPC. A custom source controls distribution; it does not reduce those runtime privileges. Only install reviewed releases.

Releases require passing type checks, regression tests, production dependency audit and secret scanning. The release workflow builds from the selected immutable tag and refuses to overwrite a release. CI actions are pinned to commits. Upstream updates require review.

Use a Cloudflare API Token restricted to the necessary zones and DNS operations. Automatic zone discovery additionally needs zone-read capability. Database configuration, records.json and backups contain recoverable credentials and must remain private. A missing or offline node status now prevents DNS updates.

Back up the Komari database and data/plugin-data/cf-ddns/ before switching versions. Use the same plugin short to preserve data; do not uninstall or delete its data as a migration step. Rollback by reinstalling a verified previous ZIP after backing up. Avoid reinstalling an official-source copy over this maintained version.
