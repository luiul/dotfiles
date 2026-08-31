# VS Code

Stows `settings.json`, `keybindings.json`, and `extensions.json` (recommendations) into
`~/Library/Application Support/Code/User/`.

Installed extensions are tracked in the Brewfile (`vscode "..."` entries). The pre-commit
hook regenerates the Brewfile from the live system via `brew bundle dump --force`, so
uninstalling an extension locally removes it from the Brewfile on the next commit.

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

## Performance Settings

These settings in `settings.json` are tuned for speed:

- `emeraldwalk.runonsave`: the sqlfmt command runs with `isAsync: true` so saves never
  block on formatting.
- `git.blame.editorDecoration.enabled: false`: skips running blame decoration on every
  opened file (status bar blame stays on).
- `python.analysis.typeCheckingMode: "basic"`: cheaper Pylance analysis on large repos.
- `makefile.configureOnOpen: false` and `terraform.codelens.referenceCount: false`:
  avoid extra language server work on open.
- `editor.renderWhitespace: "boundary"`, `editor.bracketPairColorization.enabled: false`,
  `editor.smoothScrolling: false`: less rendering work in large files.
- `window.openFilesInNewWindow: "off"`: files opened from Finder/CLI reuse the current
  window instead of spawning a new one (each window runs its own extension hosts).
