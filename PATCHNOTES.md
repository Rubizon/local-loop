# Patch notes

## Two-mode loop

Prompt → mode pick → Direct or Plan.

- **Direct:** text + at most one command. Default: nothing enters working context. **Add** rewrites the whole context from the current document + this prompt + reply (optional command output). No `KEEP GOAL` → empty. Drop a line by asking, not by clicking delete.
- **Plan:** a 3–6 step tree. Execute → checkpoint → execute. Checkpoints compare output to `expect`, force summary attach on overflow, can ask you, replan remaining steps, or start over and roll back generated files.
- Context is one always-visible document. Durable facts: `KEEP …`  Objective: `KEEP GOAL: …`
- Mode toggle plus `plan:` / `do:` prefixes. Token budget shown before send.
- The model is never given a listing of this repo.
