# Raycast

One script command package: `cc.sh`, "Focus Command Center".

## What it does

Focuses the Ghostty window whose focused tab carries the locked title
`🎛 cc` (locked with the Ghostty keybind `cmd+shift+c`, `set_tab_title`,
see the `ghostty` package). If no window carries the title, it opens a new
Ghostty window at `$HOME` and locks the title automatically by sending
`cmd+shift+c` to it.

## One-time Raycast setup

1. Raycast → Settings → Extensions → Script Commands → Add Directories.
2. Add `~/.config/raycast/scripts`.
3. Find "Focus Command Center" in Raycast, Record Hotkey: `⌃⌥⌘⇧C`
   (that is `super+c` via the Karabiner caps-lock mapping, see the
   `karabiner` package).
4. Remove that hotkey from whatever held it before (it opened Claude).

## Notes

- Open is deliberately the last resort: the script only opens a new window
  when the System Events listing, run twice after activation, confirms no
  window carries the title. On any listing error it fails loudly with a
  notification and opens nothing.
- The focus path finds and raises the cc window through Ghostty's own AppleScript dictionary (`every window whose name is …` plus `activate window`), never through the System Events AX tree. The previous version listed windows via System Events after an activate, but macOS culls the AX tree of backgrounded apps (luiul/dashkit#9) and the re-materialization after activate races any fixed delay: losing that race made the script open a duplicate command center even though one existed. Ghostty answers for its own windows without the AX tree, so that race is gone. Accessibility permission is still needed for the claim path, which sends `cmd+shift+c` via System Events `keystroke`.
- The auto-claim only sends the keystroke when the focused Ghostty tab is a
  fresh home shell titled `~`, so the lock can never land on a worktree
  window.
