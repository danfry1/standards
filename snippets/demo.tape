# VHS demo tape template. See ../rust-release.md § Demo GIF. Replace <crate>/<BIN_ENV>.
# Run via record.sh, NOT directly — it builds --release and exports the binary path.
#
# VHS 0.11 needs a BARE output filename (no path); the gif lands in the cwd
# record.sh runs vhs from (demo/).
Output <crate>.gif

Set Shell "bash"
Set FontSize 15
Set Width 1180
Set Height 760
Set Padding 18
Set TypingSpeed 60ms
Set WindowBar Colorful

# --- off-camera: launch and wait for first paint ---
Hide
Type "$<BIN_ENV>"        # e.g. $HACKER_NEWS_TUI_BIN, exported by record.sh
Enter
Sleep 3.5s               # generous if the app does network I/O on startup
Show

# --- drive the key features; keep Sleeps long enough to read each state ---
Sleep 1500ms
Down
Sleep 600ms
Enter
Sleep 1500ms
Escape
Sleep 1000ms
