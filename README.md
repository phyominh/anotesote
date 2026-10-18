# study-kb-mcp

A personal study knowledge base exposed to Claude as a custom MCP connector. It runs as a single PocketBase binary: the MCP endpoint is a JS hook inside PocketBase, with no separate server process.

Status: under construction. See [`HANDOVER.md`](HANDOVER.md) for the full spec and [`docs/design.md`](docs/design.md) for the decisions made on top of it.

## Development

Unit tests for the pure `pb_hooks/lib/` modules need only Node 20 or newer, with no dependencies:

```sh
npm test
```

## License

MIT. See [`LICENSE`](LICENSE).
