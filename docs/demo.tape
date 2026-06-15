# Reproducible README demo GIF, scripted with VHS (https://github.com/charmbracelet/vhs).
#
# Regenerate after changing the demo:
#   docker compose --profile demo up -d        # stack must be running
#   vhs docs/demo.tape                          # writes docs/demo.gif
#   git add docs/demo.gif && git commit
#
# Keep this in sync with scripts/demo.sh so the GIF never lies.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1100
Set Height 760
Set Padding 18
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Type "./scripts/demo.sh"
Sleep 600ms
Enter

# Let the whole run play out (register → baseline → mutate → detect).
Sleep 14s
