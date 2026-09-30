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

## Start on Ubuntu

Clone once. After that, this is the only command. It fetches `main`, then starts the copy of the script it just downloaded, then serves the app.

```bash
git clone https://github.com/Rubizon/local-loop.git
cd local-loop
bash run.sh
```

Open http://127.0.0.1:3847

`run.sh` resets this checkout to `origin/main`. Local edits in tracked files are discarded. `data/` is left alone. Set `PORT` if 3847 is taken. Set `OLLAMA_MODEL` before `bash run.sh` when a model should answer.

## Earlier harness

```bash
npm install
npm test
OLLAMA_MODEL=qwen2.5-coder:3b-8k npm start
```


A plan can ask one question. The answer rewrites the plan. Reports may be short markdown: headings, lists, emphasis, and code. Only normal web links are clickable.
