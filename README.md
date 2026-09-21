# local-loop

Local web UI + Node loop for a small Ollama model (Qwen2.5-Coder 3B).

Every prompt is classified, then run in one mode:

**Direct (A)** — answer, at most one command. Nothing is stored. Press **Add** to rewrite the whole working context from this turn (optional: include command output). If there is still no `KEEP GOAL`, context is emptied.

**Plan (B)** — a small task tree. Each step: execute → checkpoint (does output match expect? is context overflowing?) → next, replan, or start over with file rollback. A step with no command can emit one from context or ask you. Generated files written during the plan are snapshotted and rolled back on replan / start over.

Context is one visible document. Flag durable lines `KEEP` / `KEEP GOAL`. Drop something by asking, not by clicking.

The model never receives a listing of this repo. Prefix `plan:` or `do:` to force a mode, or use the Direct / Plan toggle.

```bash
git clone https://github.com/Rubizon/local-loop.git
cd local-loop
git pull
npm install
npm test
OLLAMA_MODEL=qwen2.5-coder:3b-8k npm start
```

Open http://127.0.0.1:3847

Try:

- `go to /tmp and list files` — Direct, one command, nothing stored until Add
- `list /tmp then write a short report of the names` — Plan
- `look in my chat logs for all my angry remarks, collect them and put them into an excel and zip the excel` — Plan with emit + zip
