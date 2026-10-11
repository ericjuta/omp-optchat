# Eval file formats

Reference only; see `rubric.md` for status. All files are JSON Lines (one JSON object per line), UTF-8. Fields marked optional may be omitted.

## Dataset layout

    evals/data/<split>/<dataset-id>/
      chat.jsonl      the messages to replay, in order
      probes.jsonl    questions to ask, with answers
      labels.jsonl    ground-truth labels for System One questions
      meta.json       {seed, generator_version, messages, created_at}

`<split>` is `dev`, `heldout` or `adversarial`.

## Run configs: evals/configs/<name>.json

Configs name omp-optchat flags and OMP model roles. They never hold a model id read from an environment variable.

    {"name": "baseline",
     "constants": {"NODE": 512, "VIEW_UPPER_BYTES": 128000, "VIEW_TARGET_BYTES": 64000,
                   "JOBS": 8, "TRIES": 5, "CAP": 30000, "RETRY": "on next append (no timer)"},
     "flags": {"rules": false, "prefetch": false, "valueScore": false, "toolGate": false, "codemode": false},
     "thresholds": {"ruleAdd": 0.8, "toolAsk": 0.3, "prefetchK": 8, "prefetchMin": 0.5, "prefetchDepth": 1},
     "models": {"agent": "session model", "compactor": "--optchat-model (default @smol)",
                "system_one": "judge role (Jev) | fake",
                "eval_judge": "a model role other than judge, from a different family than agent and compactor"},
     "repeats": 3, "budget_usd": 20}

Flag names match the plugin's command-line flags: `--optchat-rules`, `--optchat-prefetch`, `--optchat-value-score`, `--optchat-tool-gate`. Thresholds match `--optchat-rule-add`, `--optchat-tool-ask`, `--optchat-prefetch-k` and `--optchat-prefetch-min`.

## chat.jsonl

    {"i": 0, "kind": "user", "text": "...", "tags": ["fact:f12"]}
    {"i": 1, "kind": "talk", "text": "..."}
    {"i": 2, "kind": "tool", "text": "bash {\"cmd\":\"cat config.yml\"}"}
    {"i": 3, "kind": "echo", "text": "...", "tags": ["injection:inj4"]}
    {"i": 4, "kind": "work", "text": "...", "tags": ["report:sub2"]}

`kind` is one of `user`, `talk`, `tool`, `echo`, `note`, `work`, matching omp-optchat's message kinds. `tags` (optional) link a message to what was planted in it: `fact:<id>`, `rule:<id>`, `supersedes:<id>`, `injection:<id>`, `tool_risk:<id>`, `report:<id>`.

## probes.jsonl

    {"id": "p31", "ask_at": 1840, "type": "fact", "question": "Which port is the staging DB on?",
     "answer": "6543", "source": [212], "match": "contains"}

- `ask_at`: the probe is asked as a user turn right after message `ask_at` has been replayed.
- `type`: `fact`, `rule`, `supersede`, `injection`, or `tool`.
- `source`: message ids that hold the answer (used for M2 findability and age buckets).
- `match`: `exact`, `contains`, `regex`, or `judge` (judge compares meaning).

Probe answers never enter the replayed chat, so a later probe can't be answered from an earlier one.

## labels.jsonl

    {"i": 812, "question": "is_rule", "label": true}
    {"i": 815, "question": "supersedes", "label": "r3"}
    {"i": 2043, "question": "tool_risk", "label": "destructive"}
    {"i": 77, "question": "value_label", "label": "noise"}

## experiments/results.jsonl

One line per scored run:

    {"run": "2026-10-12T14:03Z-baseline-dev-s1", "experiment": "000-baseline", "config": {...},
     "split": "dev", "dataset": "seed1", "commit": "abc1234",
     "gates": {"G1": "pass", "G2": "pass", "G3": 0.004, "G4": "pass", "G5": "pass"},
     "metrics": {"M1": 0.71, "M1_curve": [0.98, 0.91, 0.74, 0.55, 0.38], "M2": 0.66,
                 "M2_zooms_median": 3, "M3_latest": 0.82, "M3_stale": 0.07, "M4_support": 0.93,
                 "M5a": {"is_rule": 0.11}, "M5b": 0.58, "M6a": 0.84, "M6b": 0.031,
                 "M6c_p95_ms": 21000, "M6d": 71200},
     "prices": {"agent_in": "unknown", "agent_out": "unknown", "cache_read": "unknown", "judge_in": 0.042},
     "usage": {"source": "session model_usage rows", "judge_calls": 0, "unjournaled_calls": 0},
     "notes": "..."}

`config` holds every constant, flag and threshold the run used, so any row can be reproduced. A price that was not recorded is `"unknown"`, never `0`.

## Usage source

Cost and cache numbers come from the session JSONL's `model_usage` entries and from omp-optchat's own artifacts (its store directory). Each judge call is counted in `usage` even when the usage row is missing, so a missing row shows as `unjournaled_calls`, not as a free call.
