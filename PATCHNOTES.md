# Patch notes

The running app is the Node server (`bash run.sh`). Behavior that used to be described here and is no longer true: a 2.5s idle kill, an 8s wall clock, one approval for a whole script, and refusing a new prompt while a run is open.

Current behavior is in the README. In short:

- The model sees State, not the chat. One command, then it waits for Approve.
- Stdin is closed. No output for 8 seconds, or 20 seconds total, kills the command (`exit 124`).
- A command that exits 0 and prints nothing is a success.
- Files that step created or edited in the working directory are rolled back if the step fails.
- A guessed command is not offered. The page says it is unsure.
- `protocol/` is not served.
