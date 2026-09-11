# VS Code

Stows `settings.json`, `keybindings.json`, and `extensions.json` (recommendations) into
`~/Library/Application Support/Code/User/`.

Installed extensions are tracked in the Brewfile (`vscode "..."` entries). The pre-commit
hook regenerates the Brewfile from the live system via `brew bundle dump --force`, so
uninstalling an extension locally removes it from the Brewfile on the next commit.

One extension is not from the Marketplace: `luiul-window-registry`, the window registry
writer from [dashkit](https://github.com/luiul/dashkit) (`vscode-window-registry/`).
`setup.sh` symlinks the dashkit checkout into `~/.vscode/extensions/`; the source of truth
stays in dashkit, so there is no copy to drift. It activates after a Code restart and
writes one small JSON file per window into `~/.local/state/vscode-windows/`.

## Draw.io Diagrams

`hediet.vscode-drawio` (installed via the Brewfile, recommended in `extensions.json`)
edits `.drawio`, `.drawio.svg`, and `.drawio.png` files in place, offline by default.
The convention for sharing diagrams in GitHub READMEs is one `.drawio.svg` file per
diagram under `docs/diagrams/`: the file is both the rendered image and the editable
source, so no export step is needed. The full convention (CLI creation, browser
edit links, migration of old `.png` + `.drawio` pairs, the two-file fallback flow) is
in [`docs/diagrams.md`](../docs/diagrams.md). The only drawio setting in
`settings.json` is `hediet.vscode-drawio.appearance: "automatic"`, so the diagram
editor follows the VS Code theme.

## Removed Extensions (2026-08-31, performance prune)

These were uninstalled to speed up startup and reduce background load. Reinstall any of
them with `code --install-extension <id>` (or add back to the Brewfile and run
`brew bundle --file=brew/Brewfile`):

| Extension | What it does | Reinstall |
| --- | --- | --- |
| `ms-vsliveshare.vsliveshare` | Live Share collaborative editing | `code --install-extension ms-vsliveshare.vsliveshare` |
| `amazonwebservices.aws-toolkit-vscode` | AWS explorer, Lambda, CloudFormation | `code --install-extension amazonwebservices.aws-toolkit-vscode` |
| `rangav.vscode-thunder-client` | REST API client | `code --install-extension rangav.vscode-thunder-client` |
| `ms-toolsai.datawrangler` | Dataframe cleaning UI | `code --install-extension ms-toolsai.datawrangler` |
| `yzane.markdown-pdf` | Markdown to PDF export | `code --install-extension yzane.markdown-pdf` |
| `marp-team.marp-vscode` | Marp slide decks | `code --install-extension marp-team.marp-vscode` |
| `redhat.vscode-xml` | XML language server | `code --install-extension redhat.vscode-xml` |
| `docsmsft.docs-yaml` | Microsoft Docs YAML schema (its `yaml.schemas` entry was removed from settings.json too) | `code --install-extension docsmsft.docs-yaml` |
| `mathiasfrohlich.kotlin` | Kotlin language support | `code --install-extension mathiasfrohlich.kotlin` |
| `pbkit.vscode-pbkit` | Protocol Buffers support | `code --install-extension pbkit.vscode-pbkit` |
| `tomaszbartoszewski.avro-tools` | Avro schema viewer | `code --install-extension tomaszbartoszewski.avro-tools` |
| `ms-azuretools.vscode-docker` | Legacy Docker extension, superseded by `docker.docker` | `code --install-extension ms-azuretools.vscode-docker` |
| `ms-azuretools.vscode-containers` | Legacy Containers extension, superseded by `docker.docker` | `code --install-extension ms-azuretools.vscode-containers` |

The `aws.telemetry` / `aws.cloudformation.telemetry` settings in settings.json are
harmless no-ops while the AWS toolkit is uninstalled; they apply again if it comes back.

## Removed Extensions (2026-09-07, terminal notifier dedupe)

Two terminal notification extensions did the same job; both were removed.

| Extension | What it does | Reinstall |
| --- | --- | --- |
| `jaredly.background-terminal-notifier` | Notification when a background terminal command finishes | `code --install-extension jaredly.background-terminal-notifier` |
| `wenbopan.vscode-terminal-osc-notifier` | Notifications via OSC 9 escape sequences | `code --install-extension wenbopan.vscode-terminal-osc-notifier` |

## Removed Extensions (2026-09-07, GitLens)

GitLens was removed. The built-in blame settings (`git.blame.editorDecoration.enabled`
and `git.blame.statusBarItem.enabled`) cover inline blame and status bar blame, and
GitLens's defaults are heavy: code lens runs `git log` per open file and current-line
blame annotates every line. The `gitlens.*` settings were removed from settings.json
with it.

| Extension | What it does | Reinstall |
| --- | --- | --- |
| `eamodio.gitlens` | Git blame, history, and code lens | `code --install-extension eamodio.gitlens` |

## Removed Extensions (2026-09-10, performance prune: packs and redundant tools)

Pruned after a startup/background-load audit. The Brewfile drops these automatically on
the next commit via the pre-commit hook; the entries were also removed from
`extensions.json` recommendations.

| Extension | What it does | Reinstall |
| --- | --- | --- |
| `ms-toolsai.jupyter` (+ `jupyter-keymap`, `jupyter-renderers`, `vscode-jupyter-cell-tags`, `vscode-jupyter-powertoys`, `vscode-jupyter-slideshow`) | Notebook kernels and tooling. The core notebook editor stays, only execution/rich output is gone | `code --install-extension ms-toolsai.jupyter` |
| `ms-vscode-remote.vscode-remote-extensionpack` (+ `remote-containers`, `remote-ssh`, `remote-ssh-edit`, `remote-explorer`, `remote-server`) | Dev Containers and SSH remoting | `code --install-extension ms-vscode-remote.vscode-remote-extensionpack` |
| `altimateai.vscode-altimate-mcp-server` | dbt MCP server, ran a background process per window | `code --install-extension altimateai.vscode-altimate-mcp-server` |
| `geddski.macros` | Dead config: its only macro (`refreshTerminal`) had no keybinding. The `macros` block was removed from settings.json with it | `code --install-extension geddski.macros` |
| `pjmiravalle.terraform-advanced-syntax-highlighting` | Redundant next to `hashicorp.terraform`'s language server | `code --install-extension pjmiravalle.terraform-advanced-syntax-highlighting` |
| `bierner.github-markdown-preview` (+ `markdown-checkbox`, `markdown-emoji`, `markdown-footnotes`, `markdown-preview-github-styles`) | GitHub-style markdown preview pack. `markdown-all-in-one` and `markdownlint` are kept. The `markdown-preview-github-styles.colorTheme` setting was removed too | `code --install-extension bierner.github-markdown-preview` |
| `oderwat.indent-rainbow` | Colored indent guides, repaints on every editor change. Replaced by native `editor.guides.indentation` | `code --install-extension oderwat.indent-rainbow` |

Also removed with this prune: `jupyter.askForKernelRestart` (dead without the Jupyter
extension), the `git-graph.*` block (`mhutchie.git-graph` is not installed), and the
dead `editor.minimap.autohide` / `editor.minimap.renderCharacters` keys from
settings.json, plus `bierner.markdown-mermaid` from `extensions.json` recommendations
(never installed).

Collateral damage found later the same day: `innoverio.vscode-dbt-power-user` was also
removed. It hard-depends on `altimateai.vscode-altimate-mcp-server`
(`extensionDependencies`), so uninstalling the MCP server took dbt Power User with it,
and the Brewfile pre-commit dump cemented the removal. dbt Power User is meant to stay
installed for dbt projects, so both extensions were reinstalled. Keep both or neither.
To keep the Altimate extension inert, settings.json sets `altimate.disableMcpServer`,
`altimate.codeAutoUpdate: false`, and `altimate.codeLens.enabled: false`.

## Removed Extensions (2026-09-10, second pass: eager activation costs)

Measured with `Developer: Startup Performance` after the first prune. These four were
the last extensions with meaningful eager (startup-blocking) activation cost.

| Extension | What it does | Reinstall |
| --- | --- | --- |
| `johnpapa.vscode-peacock` | Colored window borders, ~117ms eager activation in every window | `code --install-extension johnpapa.vscode-peacock` |
| `mtxr.sqltools` + `koszti.snowflake-driver-for-sqltools` | SQL client + Snowflake driver, ~100ms eager activation. The `sqltools.currentQueryBg` color customization was removed from settings.json too | `code --install-extension koszti.snowflake-driver-for-sqltools` |
| `mechatroner.rainbow-csv` | CSV column coloring. Activated on any plaintext file to sniff for CSV content (~1s finish under load) | `code --install-extension mechatroner.rainbow-csv` |

## Performance Settings

These settings in `settings.json` are tuned for speed:

- `emeraldwalk.runonsave`: the sqlfmt command runs with `isAsync: true` so saves never
  block on formatting.
- `git.blame.editorDecoration.enabled: true`: inline blame on the current line
  (built-in, replaces GitLens). Status bar blame stays on.
- `python.analysis.typeCheckingMode: "basic"`: cheaper Pylance analysis on large repos.
- `makefile.configureOnOpen: false` and `terraform.codelens.referenceCount: false`:
  avoid extra language server work on open.
- `editor.renderWhitespace: "boundary"`, `editor.bracketPairColorization.enabled: false`,
  `editor.smoothScrolling: false`: less rendering work in large files.
- `window.openFilesInNewWindow: "off"`: files opened from Finder/CLI reuse the current
  window instead of spawning a new one (each window runs its own extension hosts).
- `terminal.integrated.gpuAcceleration: "off"`: measured on this machine, the DOM
  renderer drains heavy output about 2x faster than WebGL (650-830ms vs 1650-1900ms
  per 300k lines).
- `terminal.integrated.persistentSessionScrollback: 100`: less scrollback to serialize
  and restore on every window reload.
- `terminal.integrated.lineHeight: 1.3`: fewer pixels per terminal line than 1.5.
- `python.terminal.activateEnvInCurrentTerminal: false`: new terminals reach a prompt
  without waiting for the Python envs extension to inject activation.
- `git.autofetch: false`: no background `git fetch` every 3 minutes per open repo.
- `task.allowAutomaticTasks: "off"`: opening a folder no longer runs workspace tasks.
- `files.watcherExclude` also covers `target/`, `dbt_packages/`, and `.terraform/`
  (generated dirs that churn on every dbt run or terraform init).
- `search.followSymlinks: false`: search does not follow symlink trees (stow).
- `workbench.reduceMotion: "on"`: no UI animations.
- `workbench.editor.limit.enabled` / `.value: 10`: caps open editors, the
  least-recently-used one closes past 10 (memory + clutter).
- `editor.guides.indentation: true`: native indent guides (replaces indent-rainbow).
- `extensions.autoCheckUpdates: false`: skips ~50 marketplace version-check requests
  at every startup. Update extensions manually: Extensions view > ... > Check for
  Updates.

- `editor.codeLens: false` (TRIAL): CodeLens providers re-run on every document
  change. Revert if reference/test lenses are missed.
- `git.autorefresh: false` (TRIAL): no repo rescan on every file event. Cheaper SCM,
  but the git status badge can go stale until manual refresh. Revert if annoying.

Workspace-scoped extension disabling (gear icon on an extension > Disable (Workspace))
is stored in VS Code's internal state, not in any file, so it cannot be stowed here.
Worth doing once per repo: disable `innoverio.vscode-dbt-power-user`,
`hashicorp.terraform`, `docker.docker`, and `ms-kubernetes-tools.vscode-kubernetes-tools`
in repos that never touch them (e.g. dotfiles); disable the web stack
(`ms-vscode.live-server`, `peakchen90.open-html-in-browser`, `ecmel.vscode-html-css`,
`piyushsarkar.sort-css-properties`) in data repos.

## Hidden Palette Commands

`subframe7536.custom-ui-style` puts `Custom UI Style: Reload` right next to
`Developer: Reload Window` in the command palette, so it is easy to pick by
accident. VS Code cannot hide one extension command natively, and the extension
has no setting for it. `.local/bin/patch-custom-ui-style-palette.sh` in this
package (stowed onto PATH) patches the extension's `package.json` with a
`menus.commandPalette` entry of `when: "false"`. The command still works, it is
only hidden from the palette. Styles still auto apply on settings save because
`custom-ui-style.watch` defaults to true.

Extension updates replace the manifest and wipe the patch, so re-run the script
after updating extensions. It is idempotent; `--check` reports status without
changing anything.
