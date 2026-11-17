# Compressor retry census

```sh
bun scripts/compressor-retry-census.ts 0.16.6 \
  2026-11-14T20:30:52.745Z 2026-11-18T00:00:00Z \
  /path/to/store /path/to/another/metrics.jsonl
```

Pass metric files or store directories explicitly. Inputs are streamed read-only and duplicate resolved paths are counted once. The UTC interval includes the start and excludes the end. For an exact version cohort, the persisted `pluginVersion` must match. Older installs did not stamp the version; use `unversioned` in place of the version to get a **separate**, time-scoped cohort. A package install timestamp is not proof of the version running in an already-open process. `unknown` is not a version match.

The reader uses the v0.16.6 retry vocabulary. It groups completed compressor rows by model and node (`leaf` or `merge`), with counts by attempt number and retry cause. `retryShare` is retry rows divided by all eligible call rows in that group, not the fraction of nodes that retried. A cause describes the **previous** attempt's defect; counts at successive attempts are not linked chains. Metrics lack a per-job key and do not establish final stored size, final success, or unrecorded calls. Do not compare cohorts as a controlled experiment.

Output includes aggregate counts, model IDs and the supplied interval, not file paths, individual timestamps, or provider error text. `skipped` classifies nonblank rows once: malformed JSON/non-object, non-compressor type, outside interval, version mismatch, or incompatible fields (including missing timestamps and old rows without attempt metadata). Sparse cells mean zero eligible observations. Concurrently appended files are not a point-in-time snapshot; use an explicit end cutoff and report the scope examined.
