# opencode-copilot-cli-auth

Package on npm: https://www.npmjs.com/package/@zhzy0077/opencode-copilot-cli-auth

This plugin now uses the Copilot CLI-style OAuth flow: it keeps the GitHub OAuth token, fetches Copilot entitlement from `/copilot_internal/user`, and uses the entitlement-provided Copilot API base URL instead of exchanging the token at `/copilot_internal/v2/token`.
It also fetches the live Copilot `/models` catalog during auth loading and patches model limits in memory so opencode sees the account-specific context and output sizes.

## Updating

```zsh
./script/publish.ts
```
