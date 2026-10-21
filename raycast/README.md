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

- The focus path ports dashkit's OpenGhostty pattern (activate before the
  System Events listing, then AXRaise the exact-title match): backgrounded
  apps can cull their AX tree and a blind open would stack duplicate
  windows (luiul/dashkit#9).
- The auto-claim only sends the keystroke when the focused Ghostty tab is a
  fresh home shell titled `~`, so the lock can never land on a worktree
  window.
