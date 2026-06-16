-- ClaudeNotifier - click-to-focus notification helper for Claude Code hooks.
--
-- A compiled .app applet does NOT receive command-line argv, so notify.sh
-- communicates through two files in the temp dir instead:
--   * pending file : message<TAB>title<TAB>bundleId  - written by notify.sh
--                    right before launching the app to POST a banner.
--   * target file  : bundleId only - the terminal to focus on click.
--
-- Modes are disambiguated by the pending file's existence (deterministic):
--   POST  : pending file present -> read it, store the target, post the
--           banner, delete the pending file, exit.
--   FOCUS : no pending file (the click relaunch from a banner) -> read the
--           stored target and activate that app.
--
-- The banner is posted by THIS app, so the OS routes the click back to it.
-- Built with: osacompile -o ~/Applications/ClaudeNotifier.app ClaudeNotifier.applescript

on tmpDir()
	return do shell script "printf '%s' \"${TMPDIR:-/tmp}\""
end tmpDir

on pendingPath()
	return tmpDir() & "claude-notifier-pending"
end pendingPath

on targetPath()
	return tmpDir() & "claude-notifier-target"
end targetPath

on readFile(p)
	try
		return do shell script "cat " & quoted form of p
	on error
		return ""
	end try
end readFile

on postMode()
	set payload to readFile(pendingPath())
	-- Consume the pending file immediately so a later click is treated as FOCUS.
	do shell script "rm -f " & quoted form of pendingPath()
	if payload is "" then return
	set savedDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to tab
	set parts to text items of payload
	set AppleScript's text item delimiters to savedDelims
	if (count of parts) < 3 then return
	set msg to item 1 of parts
	set theTitle to item 2 of parts
	set bundleId to item 3 of parts
	if bundleId is not "" then
		do shell script "printf '%s' " & quoted form of bundleId & " > " & quoted form of targetPath()
	end if
	display notification msg with title theTitle sound name "default"
end postMode

on focusMode()
	set bundleId to readFile(targetPath())
	if bundleId is "" then return
	try
		do shell script "open -b " & quoted form of bundleId
	end try
end focusMode

on dispatch()
	-- Pending file present => this launch is a POST request from notify.sh.
	-- Otherwise it is a click relaunch (or manual open) => FOCUS.
	set hasPending to (do shell script "test -f " & quoted form of pendingPath() & " && printf yes || printf no")
	if hasPending is "yes" then
		postMode()
	else
		focusMode()
	end if
end dispatch

on run
	dispatch()
end run

on reopen
	-- If the OS re-activates the already-running app instead of relaunching it.
	dispatch()
end reopen
