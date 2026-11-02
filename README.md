# OpenCode Copilot Fusion

Use GitHub Copilot Fusion from OpenCode V2 through the standard Responses protocol.

## Install from the Git tag

Add this to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "copilot-fusion-direct/fusion",
  "plugins": [
    "git+https://github.com/OMGDemoPlayground/opencode-copilot-fusion.git#v0.1.1"
  ]
}
```

Use `git+https` rather than the bare `github:` shorthand so installation does not require an SSH key.

## Install in OpenCode Desktop

- Edit `~/.config/opencode/opencode.json` and preserve existing settings.
- Add the Git tag spec and token-file option from the example above.
- Restart OpenCode Desktop after changing the config.
- Allow the first activation to finish while OpenCode downloads the Git package; a model-list command can time out before that download completes.
- Select `copilot-fusion-direct/fusion` and run a short request.

## Image input

- Attach PNG, JPEG, GIF, or WebP images to an OpenCode prompt.
- Keep the model on `copilot-fusion-direct/fusion`; the plugin marks it image-capable.
- The plugin routes image requests with `has_image: true`, selects a vision-capable Fusion model, and returns the normal Responses stream.
- Reject image requests when Fusion selects a model without vision instead of silently dropping the image.

## Provide the token

Set `FUSION_TOKEN_FILE` to a JSON file containing `tokens.access_token` or a top-level `access_token`:

```sh
FUSION_TOKEN_FILE=/absolute/path/to/tokens.json opencode
```

Alternatively, set `FUSION_ACCESS_TOKEN` directly. Do not commit either value.

## Select the model

Select `copilot-fusion-direct/fusion`, or keep it as the `model` in `opencode.json`. The plugin routes with Intelligence by default.

## How it works

- The plugin adds the `copilot-fusion-direct` provider and a tools-capable model named `fusion`.
- On each model request it calls `POST /auto` with `fusion: true` and `tier: intelligence`.
- It caches the selected model and Fusion session token by OpenCode session plus prompt hash.
- It forwards the original Responses payload, including tools and tool results, to `/responses`.
- It executes no tools. OpenCode runs its native tools and sends their results back through the same route.
- It stabilizes opaque item IDs across streamed Responses events.

## Options

Pass options through the plugin entry when needed:

```json
{
  "plugins": [
    {
      "package": "git+https://github.com/OMGDemoPlayground/opencode-copilot-fusion.git#v0.1.1",
      "options": {
        "tokenFile": "/absolute/path/to/tokens.json",
        "tier": "intelligence"
      }
    }
  ]
}
```

Supported options: `tokenFile`, `upstream`, `tier`, and `timeoutMs`. Environment equivalents are `FUSION_TOKEN_FILE`, `FUSION_ACCESS_TOKEN`, `FUSION_UPSTREAM`, and `FUSION_TIER`.

## Release assets

Download the release `.tgz` and extract it into `~/.config/opencode/plugins/opencode-copilot-fusion` for a local install. OpenCode discovers plugin directories automatically.

## Develop

```sh
bun install
bun test
bun run typecheck
```

## Limits

- Text input and Responses-capable models only.
- No token refresh yet.
- No WebSocket transport or Copilot CLI escalation policy.
- The `/auto` endpoint is a private Copilot surface and can change.
