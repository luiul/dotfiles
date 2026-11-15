# dbt MCP for Global Ops

The official [dbt MCP server](https://docs.getdbt.com/docs/dbt-ai/setup-local-mcp) is pinned to version 2.10.1 and launched by `pi-dbt-mcp`.

`pi/.local/bin/pi-dbt-mcp` is stowed into `~/.local/bin`. It resolves the current Git worktree and sets the dbt project and executable paths from that checkout. Outside Global Ops, it fails with an explanation instead of using an unrelated checkout. Set `PI_DBT_REPO_ROOT` only for an explicit checked source root.

The MCP entry lives in `~/.pi/agent/mcp-adapter.json`. Its tracked copy at `pi/.pi/agent/mcp-adapter.json` is a snapshot, not a Stow symlink, because Pi rewrites it. Refresh the snapshot after edits:

```bash
cp ~/.pi/agent/mcp-adapter.json ~/dotfiles/pi/.pi/agent/mcp-adapter.json
```

The entry is lazy and uses proxy tools. It exposes `parse`, `list`, `compile`, `get_lineage_dev`, and official documentation tools. Build, run, test, arbitrary SQL, and platform tools are not exposed by default. Compile can query the warehouse through macros, so it is not an offline guarantee.

The launcher uses the repo’s existing virtual environment without syncing it. The MCP server runs separately through `uvx`, using the public package index and ignoring the repo’s private index configuration. It stores no tokens in config. Warehouse commands still need the normal Databricks login and explicit target/catalog isolation.

After config changes, run `/reload` in an idle Pi session. The built-in `pi mcp` CLI does not read adapter config, so it is not a test of this setup. The adapter owns `/mcp` in the current configuration.

A real MCP client initialized this server and called `parse` against the GLOA-867 source worktree successfully. That verifies server/tool operation, not warehouse permissions or model correctness.

## Stow conflicts

The first full `stow pi` simulation found pre-existing non-Stow-owned files under `.pi` and `bin`. Nothing was overwritten. The launcher was deployed with a scoped invocation that excludes those roots:

```bash
cd ~/dotfiles
stow --simulate --verbose=1 --ignore='^\.pi$' --ignore='^bin$' pi
stow --ignore='^\.pi$' --ignore='^bin$' pi
```

Resolve unrelated Stow ownership conflicts separately. Do not use `--adopt` to overwrite them as part of MCP setup.
