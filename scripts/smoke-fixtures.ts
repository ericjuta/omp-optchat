import { deflateSync } from "node:zlib";

export const SIDE_PROMPT = "OPTCHAT_SMOKE_EPHEMERAL_ONLY: give a synthetic side-turn acknowledgement.";
export const SIDE_REPLY = "OPTCHAT_SMOKE_EPHEMERAL_ACK";
export const ASYNC_ID = "optchat-smoke-background";
export const ASYNC_PREVIEW = "Synthetic background report preview; details contain the complete validated report.";
export const ASYNC_BODY = `OPTCHAT_SMOKE_REPORT_BEGIN\n${"A public synthetic report detail, never private reasoning.\n".repeat(900)}OPTCHAT_SMOKE_REPORT_END`;
export const ASYNC_SCHEMA = { source: "yield", mode: "strict", status: "valid", data: { report: ASYNC_BODY } } as const;
export const CHILD_TASK = "OPTCHAT_SMOKE_CHILD_TASK: read the frozen parent's archive with zoom, then return the synthetic public report. Do not edit any file.";
export const CHILD_REPORT = "OPTCHAT_SMOKE_CHILD_REPORT: retrieved the frozen parent source through the child's own zoom tool.";

/** A real one-pixel PNG, with deterministic compressed scanline and correct chunk CRCs. */
export function smokePng(red: number, green: number, blue: number): string {
	const chunk = (kind: string, data: Buffer): Buffer => {
		const payload = Buffer.concat([Buffer.from(kind), data]);
		let crc = 0xffffffff;
		for (const byte of payload) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
		}
		const header = Buffer.alloc(4);
		header.writeUInt32BE(data.length);
		const trailer = Buffer.alloc(4);
		trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
		return Buffer.concat([header, payload, trailer]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(1, 0);
	header.writeUInt32BE(1, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.from([0, red, green, blue]))),
		chunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}
