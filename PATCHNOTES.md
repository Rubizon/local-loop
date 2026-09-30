# Patch notes

## Protocol

- One state plus one event. Replies are a diff and at most one script.
- Commands that need no checkup share a script and one approval. A new step exists only when the next command depends on unseen output.
- Each step has an expect line. A miss aborts the run and rolls back that step's writes.
- Commands are supervised: no output for 2.5s or a wall of 8s kills them (code 124) and returns control to the loop. Oversized scripts, bodies, and unclosed heredocs are refused.
- Denying a plan step ends the plan. A new prompt cannot start while a run is open. Saved state is normalized so an older save cannot wedge the UI.

## Earlier

Direct mode stores nothing until Add. Plan mode is a task tree with checkpoints and file rollback. The model does not receive a listing of this repo.
