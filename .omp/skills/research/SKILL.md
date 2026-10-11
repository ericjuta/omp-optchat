---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

Start **one background `task` subagent** (default agent, because it writes a file) to do the research, then keep working in the parent while it reads. Its result auto-delivers; do not block on it unless the next step depends on it.

Give the subagent, in its `task` entry: the exact question, the files, URLs or repos to start from, the output path, and this skill's rules below. It starts blank and knows nothing else.

The subagent's job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Use `web_search` to find sources and `read` on URLs and source files to read them. Follow every claim back to the source that owns it.
2. Tag every claim with exactly one of:
   - **runtime-observed**: seen by running the thing (a command, a request, a test) in this session, with the output recorded.
   - **source-read**: read in code, docs or a spec, with the path or URL and the line or section.
   - **[INFERENCE]**: a conclusion not directly observed. Say what it rests on.
3. Write the findings to a single Markdown file, citing each claim's source. Keep it to the answer, the evidence, and the open gaps. No narration of the search.
4. Save it where the repo already keeps such notes. In this repo that is `docs/research/<slug>.md`. If the repo has no convention, put it somewhere sensible and say where.
5. Do not edit code, do not change tracker state, and do not run builds or tests unless the question requires running something.

The subagent yields `{ data: { path, answer, gaps } }`, where `answer` is a short summary and `gaps` lists anything it could not verify.
