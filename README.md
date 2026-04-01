# selu-agent-bring-shopping

Bring! shopping list agent for [Selu](https://github.com/selu-bot/selu).

This agent demonstrates the dynamic MCP-wrapper pattern:

- the capability wraps `bring-mcp`
- Selu discovers tools dynamically via `list_tools`
- Selu reconciles tool permissions when upstream tools are added or removed

## Capability mode

`bring-shopping` uses dynamic tool discovery:

- `tool_source: dynamic`
- `discovery_tool_name: list_tools`
- no statically declared `tools:` in `manifest.yaml`

During setup/update/startup, Selu calls `list_tools`, stores discovered tools,
and syncs policies:

- newly discovered tools get a global default policy (recommended or secure fallback `block`)
- removed tools are deleted from global and per-user policy tables

## Credentials

Runtime tool calls require per-user Bring credentials:

- `MAIL` -- Bring account email
- `PW` -- Bring account password

These values are stored encrypted by Selu and injected only for invocation.

## Notes

- This integration depends on upstream `bring-mcp` and the unofficial Bring API.
- Dynamic discovery minimizes manual manifest maintenance when upstream tool sets change.
