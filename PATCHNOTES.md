Command output attaches to the next prompt with cmd/cwd/exit/mode metadata.

Summarize is a two-step: the model writes a keep-instruction, then compresses. You can inspect both.

Composer shows estimated tokens vs num_ctx before Send.

`/api/prompt-stats` and `/api/summarize-plan` live in server.js (not extra.js).
