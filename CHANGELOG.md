# Changelog

## [Unreleased]

### Breaking Changes

- **Environment variables renamed:**
  - `GITNEXUS_NO_GITIGNORE` → `COTX_NO_GITIGNORE`
  - `GITNEXUS_VERBOSE` → `COTX_VERBOSE`
  - `GITNEXUS_DEBUG` → `COTX_DEBUG`
- **Ignore file renamed:** `.gitnexusignore` → `.cotxignore`
  - Users must rename their project-specific ignore file

### Changed

- All internal imports migrated from `gitnexus-shared` path alias to relative paths
- Project licensed under BSL 1.1 (Change License: Apache 2.0 after 2 years)
