# gravityport-mcp

One command connects Claude, Codex, and other MCP clients to your local GravityPort library: `npx -y gravityport-mcp` starts the GravityPort MCP server from the installed desktop app.

**Install the [GravityPort desktop app](https://gravityport.azhuilab.com/en/?ref=mcp) first (macOS on Apple silicon or Intel, or Windows).** This package only starts the server that ships inside the app. When the app is missing, it still speaks MCP: your assistant sees the tool list and gets a clear "install GravityPort first" answer with the download link on every tool call, instead of an unexplained connection failure.

After installing the app, open it once, then restart your AI assistant.

## Claude Code

```bash
claude mcp add --scope user gravityport -- npx -y gravityport-mcp
```

## Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "gravityport": {
      "command": "npx",
      "args": ["-y", "gravityport-mcp"]
    }
  }
}
```

## Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.gravityport]
command = "npx"
args = ["-y", "gravityport-mcp"]
```

## App installed somewhere else?

The launcher looks in `/Applications` and `~/Applications` on macOS and `%LOCALAPPDATA%\Programs\GravityPort\app` on Windows. Point `GRAVITYPORT_APP_PATH` at your install — the `.app` directory on macOS, the folder that holds `GravityPort.exe` on Windows:

```bash
GRAVITYPORT_APP_PATH="/path/to/GravityPort.app" npx -y gravityport-mcp
```

## No Node.js on this machine?

The config copied from GravityPort's Settings → Connect runs the app's own server directly and needs no Node.js. Use that instead.

## Tools

GravityPort MCP provides 25 tools:

- **Search:** `asset_search` (text and time range), `asset_list`, `asset_get`
- **Add:** `asset_create`, `asset_import_folder`
- **Edit:** `asset_update_metadata`, `asset_attach_prompt`, `asset_duplicate`
- **Trash:** `asset_trash` (move to Trash), `asset_restore` (restore from Trash)
- **Stacks:** `stack_list`, `stack_get`, `stack_create`, `stack_rename`, `stack_add_assets`, `stack_remove_assets`, `stack_dissolve`
- **Versions:** `asset_version_create`, `asset_version_history`, `asset_recipe_history`
- **Generation history:** `generation_record`, `generation_list`, `generation_relation_record`, `generation_lineage`
- **Export:** `asset_provenance_export` (provenance without file paths or user names)
