# local-loop

Local web UI + Node loop for a small Ollama model (Qwen2.5-Coder 3B on a 4GB Pascal GPU).

Approve before any shell or file write. Working context is the right pane (lock/unlock to edit). Command output attaches to the next send (full or summarized). Footer shows an estimated prompt token budget.

```bash
git clone https://github.com/Rubizon/local-loop.git
cd local-loop
npm install
npm test
OLLAMA_MODEL=qwen2.5-coder:3b-8k npm start
```

Open http://127.0.0.1:3847

`go to /tmp and list the files` becomes `ls -la /tmp` in the runner.
