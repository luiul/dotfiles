rex.action{
  name = "copy_selection",
  title = "Copy Selection",
  run = function()
    local terminal = "com.superlogical.terminal"
    local process = rex.block.call(terminal, "process", {})
    local modes = rex.block.call(terminal, "modes", {})
    local foreground = process and process.foreground
    local name = foreground and foreground.argv0
    local pi = name and name:match("([^/]+)$") == "pi"
    local mouse = false
    if modes and modes.screen == "alternate" then
      for _, mode in ipairs(modes.modes or {}) do
        if mode.name == "mouse_format_sgr" and mode.set then mouse = true end
      end
    end

    -- Pi owns fullscreen mouse selection, so Rex has no selection to copy.
    if pi and mouse then
      rex.client.queue("pane.send_key", { key = "ctrl+x" })
    else
      rex.client.queue("pane.copy")
    end
  end,
}

rex.bind("cmd+c", "copy_selection")
