import { buildCorpus } from "../../scripts/evidence/corpus.ts";
const files = process.argv.slice(2);
const tally: Record<string, number> = {};
for (const f of files) {
  const a = await Bun.file(f).json();
  const c = a.corpus;
  const corpus = buildCorpus({ seed: c.seed, projects: (c.questionsTotal - 4) / 6, sourceCount: c.sources, minSourceBytes: c.minSourceBytes });
  if (corpus.digest !== c.digest) throw new Error("digest");
  const byId = new Map(corpus.sources.map((s) => [s.recordId, s.text]));
  const qs = new Map(corpus.questions.map((q) => [q.id, q]));
  for (const sc of a.scenarios) if (sc.status === "completed") for (const ph of sc.phases) for (const q of ph.questions) {
    if (q.failure !== "fabricated-citation") continue;
    const prev: string = q.answerPreview ?? "";
    const cites = [...prev.matchAll(/\{"recordId":(\d+),"quote":"((?:[^"\\]|\\.)*)"\}/g)].map((m) => ({ id: +m[1], quote: JSON.parse(`"${m[2]}"`) as string }));
    const src = new Set(qs.get(q.id)!.sources.map((s) => s.recordId));
    const marks = cites.map((ci) => {
      const t = byId.get(ci.id);
      const exact = t?.includes(ci.quote) ?? false;
      const elsewhere = !exact && corpus.sources.some((s) => s.text.includes(ci.quote));
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const loose = !exact && !!t && norm(t).includes(norm(ci.quote));
      const k = exact ? "exact-in-cited-record" : loose ? "whitespace-variant" : elsewhere ? "exact-in-other-record" : "not-in-corpus";
      return `${ci.id}${src.has(ci.id) ? "*" : ""}:${k}:${ci.quote.length}`;
    });
    const cls = cites.length === 0 ? "preview-no-complete-cite" : marks.every((m) => m.includes(":exact-in-cited-record:")) ? "all-shown-quotes-real" : "some-shown-quote-not-verbatim";
    const key = `${a.viewBytes} ${cls} zoomSrc=${q.zoomedSourceRecord}`;
    tally[key] = (tally[key] ?? 0) + 1;
    console.log(`s${c.seed} v${a.viewBytes} ${q.id} zooms=${q.zoomCalls} zoomSrc=${q.zoomedSourceRecord} previewLen=${prev.length} | ${marks.join(" ")}`);
    if (cls !== "all-shown-quotes-real") for (const ci of cites) { const t = byId.get(ci.id) ?? ""; if (!t.includes(ci.quote)) console.log(`   Q: ${ci.quote.slice(0,160)}\n   R: ${t.slice(0,160)}`); }
  }
}
console.log(tally);
