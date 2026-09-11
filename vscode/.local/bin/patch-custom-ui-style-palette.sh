#!/usr/bin/env bash
#
# Hide "Custom UI Style: Reload" from the VS Code command palette.
#
# The subframe7536.custom-ui-style extension puts "Custom UI Style: Reload"
# right next to "Developer: Reload Window" in the command palette, so it is
# easy to trigger by accident. VS Code has no native way to hide one extension
# command, and the extension has no setting for it. This script patches the
# extension manifest (package.json) with a menus.commandPalette entry that
# hides the command ("when": "false").
#
# The command itself still works after patching, it is only hidden from the
# palette. Styles still auto apply on settings save because
# "custom-ui-style.watch" defaults to true.
#
# The manifest is REPLACED on every extension update, so re-run this script
# after updating extensions. It is idempotent: an already patched manifest is
# left untouched. If the manifest shape changed upstream (no
# custom-ui-style.reload command found), the script warns and exits non-zero
# instead of corrupting the install.
#
# Usage:
#   patch-custom-ui-style-palette.sh           apply if needed
#   patch-custom-ui-style-palette.sh --check   report status only, exit 1 if unpatched

set -euo pipefail

flag=""
if [ "${1:-}" = "--check" ]; then
	flag="--check"
fi

shopt -s nullglob
manifests=("$HOME"/.vscode/extensions/subframe7536.custom-ui-style-*/package.json)

if [ ${#manifests[@]} -eq 0 ]; then
	echo "custom-ui-style extension not installed, nothing to do"
	exit 0
fi

status=0
for manifest in "${manifests[@]}"; do
	# $flag stays unquoted on purpose: empty expands to nothing (apply mode).
	node - "$manifest" $flag <<-'NODE' || status=1
		const fs = require("fs");

		const manifest = process.argv[2];
		const checkOnly = process.argv[3] === "--check";

		let pkg;
		try {
			pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
		} catch (err) {
			console.error(`error: cannot parse ${manifest}: ${err.message}`);
			process.exit(2);
		}

		if (pkg.name !== "custom-ui-style" || pkg.publisher !== "subframe7536") {
			console.error(`error: unexpected extension identity in ${manifest}, refusing to patch`);
			process.exit(2);
		}

		const commands = pkg.contributes?.commands ?? [];
		if (!commands.some((c) => c.command === "custom-ui-style.reload")) {
			console.error(`error: custom-ui-style.reload not found in ${manifest}, upstream manifest changed?`);
			process.exit(2);
		}

		const palette = pkg.contributes?.menus?.commandPalette ?? [];
		const existing = palette.find((e) => e.command === "custom-ui-style.reload");

		if (existing && existing.when === "false") {
			console.log(`ok: already hidden (${manifest})`);
			process.exit(0);
		}

		if (checkOnly) {
			console.log(`unpatched: ${manifest}`);
			process.exit(1);
		}

		pkg.contributes.menus ??= {};
		pkg.contributes.menus.commandPalette ??= [];
		if (existing) {
			existing.when = "false";
		} else {
			pkg.contributes.menus.commandPalette.push({ command: "custom-ui-style.reload", when: "false" });
		}

		fs.writeFileSync(manifest, JSON.stringify(pkg, null, "\t") + "\n");
		console.log(`patched: ${manifest}`);
		console.log("reload VS Code windows to apply (Developer: Reload Window)");
	NODE
done

exit "$status"
