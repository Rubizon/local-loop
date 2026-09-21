# local-loop

Local web UI + Node loop for a small Ollama model (Qwen2.5-Coder 3B on a 4GB Pascal GPU).

Approve before any shell or file write. Notes live in the right pane.

After a command runs, its output is **attached to the next Send** with metadata (`cmd`, `cwd`, `exit`, `mode`). It is not a fake user message.

- **Use full** — send the raw output (a warning shows if it is large for the 8k context)
- **Summarize** — the model first writes a keep-instruction, then compresses; you can inspect both before sending
- **Drop** — do not send the output on the next turn

The composer shows estimated prompt tokens vs the model context (`~tokens / 8192`).

```bash
git clone https://github.com/Rubizon/local-loop.git
cd local-loop
git pull
npm install
npm test
OLLAMA_MODEL=qwen2.5-coder:3b-8k npm start
```

Open http://127.0.0.1:3847

The model prompt contains only: system instructions, notes you saved, attached command output, and your message. It does not receive a listing of this repo.
