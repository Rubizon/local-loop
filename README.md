# local-loop

Supervised agent loop. One state. The model never sees the chat. Every command waits for you.

The current protocol is in [`protocol/`](protocol/). The files at the repo root are the earlier Node harness.

## How a turn works

The model receives the state plus one event, not the conversation. It answers with a short diff and at most one script.

- A **script** is commands that do not need a checkup between them. One Allow runs the whole script.
- A **stop** is the next step, and it exists only when a later command depends on output that has not been seen yet.
- After each step, the output is checked against that step's `expect`. Off the plan, the run aborts. Writes from that step are rolled back.
- A command with no output for 2.5s, or one that runs past 8s, is killed. The loop gets control back and rolls the step back.
- Denying a step ends the plan. A new prompt is refused while a run is still open.

The inbox demo is two stops: read the notes, then one script that writes `summary.txt` and the PDF.

## Earlier harness

```bash
npm install
npm test
OLLAMA_MODEL=qwen2.5-coder:3b-8k npm start
```

Open http://127.0.0.1:3847
