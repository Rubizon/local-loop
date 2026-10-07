# local-loop

A local page for a small Ollama model. It can answer, or it can ask you to approve one shell command. It is not a coding agent.

`bash run.sh` serves this Node app. The `protocol/` folder is an old sketch and is not started.

## What it is

You talk to a model that only sees the **State** panel, not the chat. The panel is short on purpose: a goal, a few facts, and what happens next. A 4B model can stay inside that. It cannot stay inside a long transcript.

A simple question gets an answer. A task that needs the machine becomes one command. You see the full command and press **Approve**. Nothing runs before that. After it finishes, the model reads the output, updates State, and shows the next command if there is one. You approve that too.

The page is meant for small jobs on the machine in front of you: read a file, list a directory, write a text file, join the files in the working directory, make a small PDF from names already in State.

A whole tree is a scan, not one prompt full of source. Ask it to read a directory and say what to look for, for example how currencies are handled. You approve the file list (60 files, skipping `node_modules`, `.git`, and `dist`). You approve the scan once. It reads each file, appends a note to a `.txt` in the working directory, and shows a summary here. State keeps the count and the path of that file, not the source. A file over about 12k characters is clipped to its start and end. Binary files and files over 400k are skipped.

## What it is not

- Not Cursor, Cline, Aider, or OpenHands. It does not edit a repository, open a pull request, or work through a codebase.
- It does not remember the chat. If it is not in State, the next turn does not know it.
- It does not run ahead. One command, then it waits.
- It does not run a program you only asked to see. The program is shown. If you asked it to run, that becomes one command you still have to approve.
- It will not invent a plan for a vague job such as "clean up my machine." It says it is unsure and asks which files and what done looks like.
- It is not a sandbox. A short deny list blocks `sudo`, `rm -rf /`, `mkfs`, `dd`, `chmod -R 777`, `chown -R`, and `curl` piped into a shell. Anything else you approve can run, including commands that touch your home directory.

## How a turn works

The model does not see the chat. It sees one small frame at a time. Thinking is turned off. Each call is capped (`goal` 48 tokens, `method` 24, `say` 160, `ask` 64, `cmd` 220, `plan` 240). The context window defaults to 4096 (`OLLAMA_NUM_CTX`).

1. You send a message. The state panel updates as soon as each beat finishes. You do not have to approve those updates. A fully specified command, such as listing a directory or writing text you already gave, skips the model and still shows the goal and the method.
2. **Goal.** One line: the outcome, not the steps. A follow-up keeps the old goal. A new job replaces it.
3. **Method.** One of `say` (just answer), `ask` (a question), `cmd` (one shell command), or `plan` (several steps).
4. **Do that and nothing else.** A plan is a list of steps. Each step names the slots it reads (`need`) and the slot it writes (`out`). A step does not receive the chat or the other slots.
5. A `say` step runs immediately and its text is both the bubble and the slot. A `cmd` step shows the full command, including more than one line, and waits. **Approve** is still required. Nothing is executed before that.
6. After a command exits 0, the slot stores a short digest (or `file written` when the command only redirected). The next step then starts. Empty output is not a failed summary.
7. An `ask` waits for your next message. That message is the answer slot, not a new goal.
8. **Clear** wipes the chat, State, and the working directory.

State lines:

| Line | Meaning |
|---|---|
| `GOAL` | The outcome |
| `METHOD` | `say`, `ask`, `cmd`, or `plan` |
| `CURSOR` | The step id now running |
| `ASK` | The question waiting on you |
| `SLOT name` | A short value passed into a later step |

## Start

Needs Node, npm, and Ollama on this machine. The first argument is the model name.

```bash
git clone https://github.com/Rubizon/local-loop.git
cd local-loop
bash run.sh qwen3:4b-instruct
```

Open http://127.0.0.1:3847

Each start of the server picks a new id. The page checks it every few seconds. When the id changes, the page reloads, so a restart does not leave you on the old page. A failed check, while the process is down, does not reload.

`run.sh` fetches `origin/main` and resets this checkout. Local edits to tracked files are discarded. `data/` is left alone, and that is where State is stored. Set `PORT` if 3847 is taken. With no argument the model is `OLLAMA_MODEL` or `qwen2.5-coder:3b-8k`.

```bash
PORT=4000 bash run.sh qwen3:4b-instruct
```

## The page

- **Test model** runs the built-in checks and downloads a report. It tells you if this model can keep the JSON the loop needs. It does not prove the model can do your task.
- **Export** downloads the chat, the steps, and State as text, so a failure can be pasted somewhere else and read.
- **Clear** starts over.
- The meter under the box is a rough token count of State plus what you are typing, against the context window (4096 unless `OLLAMA_NUM_CTX` is set).

## Checks

```bash
npm test
```

That runs the unit tests and three command checks: a command that prints, `cat` with stdin closed, and a silent `sleep` that must be killed. It does not call Ollama. `npm run test:model` also calls the configured model.

## Limits, on purpose

A 4B model still stops mid-JSON, copies an example, or picks the wrong tool. The warning and the second try cover some of that, not all of it. "Concatenate the files" does not ask the model: one Python command writes `concatenated.txt` in the working directory. Other tasks depend on the model.

Do not point it at a job you would not run by hand.
