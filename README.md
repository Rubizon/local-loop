# local-loop

Local web UI + Node loop for a small Ollama model (Qwen2.5-Coder 3B on a 4GB Pascal GPU).

Approve before any shell or file write. Notes live in the right pane (unlock to edit). Command output attaches to the next send until you drop it.

```bash
git clone https://github.com/Rubizon/local-loop.git
cd local-loop
npm install
npm test
OLLAMA_MODEL=qwen2.5-coder:3b-8k npm start
```

Open http://127.0.0.1:3847

The model prompt contains only: system instructions, notes you saved, attached command output, and your message. It does not receive a listing of this repo.
