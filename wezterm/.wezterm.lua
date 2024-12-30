local wezterm = require 'wezterm'

return {
  keys = {
    -- Disable Command + W
    {
      key = "w",
      mods = "CMD",
      action = "DisableDefaultAssignment",
    },
  },
}