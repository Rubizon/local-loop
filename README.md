# local-loop

Web frontend + local Node backend for a small Ollama coding model.

Each turn the server sends your message, a numbered context list, and last command outputs. The model returns JSON: `display`, context `ops`, `files`, `commands`, `compress`. You approve writes and shell.

## Run

Ollama must already be serving a model (default `qwen2.5-coder:3b-8k`).

```bash
git clone https://github.com/Rubizon/local-loop.git
cd local-loop
npm install
npm test
OLLAMA_MODEL=qwen2.5-coder:3b-8k WORKSPACE=$HOME/code/demo npm start
```

Open http://127.0.0.1:3847

On Pascal / old CUDA, start Ollama with `OLLAMA_LLM_LIBRARY=cuda_v12`.

## Tests

```bash
npm test
OLLAMA_MODEL=qwen2.5-coder:3b-8k npm run test:model
```

UI **Test** button runs runner checks plus a model probe (`display` must contain `PING-OK`).

## Env

- `PORT` default 3847
- `OLLAMA_HOST` default http://127.0.0.1:11434
- `OLLAMA_MODEL` default qwen2.5-coder:3b-8k
- `WORKSPACE` default cwd
- `CONTEXT_FILE` default ./data/context.json
- `MEMORY_FILE` default ./data/memory.jsonl
- `MEMORY_K` default 5
