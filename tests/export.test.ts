import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { writeExportFile } from "../src/export-file.ts";

// Captured before any spy replaces the namespace properties.
const nativeFsync = fs.fsyncSync;
const nativeLink = fs.linkSync;
const nativeUnlink = fs.unlinkSync;
const nativeWrite = fs.writeSync;

const roots: string[] = [];

afterEach(async () => {
	mock.restore();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A fresh private directory and the target file inside it. */
async function fixture(): Promise<{ dir: string; target: string }> {
	const root = await mkdtemp(join(tmpdir(), "optchat-export-"));
	roots.push(root);
	const dir = join(root, "out");
	fs.mkdirSync(dir);
	return { dir, target: join(dir, "chat.html") };
}

function errorCode(action: () => void): string | undefined {
	try {
		action();
	} catch (error) {
		return (error as NodeJS.ErrnoException).code ?? "unknown";
	}
	return undefined;
}

function fdPath(fd: number): string {
	return fs.readlinkSync(`/proc/self/fd/${fd}`);
}

describe("writeExportFile", () => {
	test("publishes complete private output, fsyncing the file before the link and the directory after it", async () => {
		const { dir, target } = await fixture();
		const realDir = fs.realpathSync(dir);
		const events: string[] = [];
		spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
			const path = fdPath(fd);
			// Temporary names this writer creates are `.<target>.<uuid>.tmp`.
			const temporary = basename(path).startsWith(`.${basename(target)}.`) && path.endsWith(".tmp");
			events.push(path === realDir ? "fsync directory" : temporary ? "fsync temporary" : `fsync ${path}`);
			nativeFsync(fd);
		});
		spyOn(fs, "linkSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
			events.push("link");
			nativeLink(from, to);
		});
		spyOn(fs, "unlinkSync").mockImplementation((path: fs.PathLike) => {
			events.push("unlink");
			nativeUnlink(path);
		});

		writeExportFile(target, Buffer.from("<html>é 漢字</html>", "utf8"));

		expect(events).toEqual(["fsync temporary", "link", "fsync directory", "unlink", "fsync directory"]);
		expect(fs.readFileSync(target, "utf8")).toBe("<html>é 漢字</html>");
		expect(fs.statSync(target).mode & 0o777).toBe(0o600);
		expect(fs.statSync(target).nlink).toBe(1);
		expect(fs.readdirSync(dir)).toEqual(["chat.html"]);
	});

	test("keeps an existing file, dangling symlink, or directory at the target and fails with EEXIST", async () => {
		const cases: Array<{ name: string; prepare: (dir: string, target: string) => void; keeps: (dir: string, target: string) => void }> = [
			{
				name: "file",
				prepare: (_dir, target) => fs.writeFileSync(target, "old"),
				keeps: (_dir, target) => expect(fs.readFileSync(target, "utf8")).toBe("old"),
			},
			{
				name: "dangling symlink",
				prepare: (dir, target) => fs.symlinkSync(join(dir, "elsewhere"), target),
				keeps: (dir, target) => {
					expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
					expect(fs.existsSync(join(dir, "elsewhere"))).toBe(false);
				},
			},
			{
				name: "directory",
				prepare: (_dir, target) => fs.mkdirSync(target),
				keeps: (_dir, target) => expect(fs.statSync(target).isDirectory()).toBe(true),
			},
		];
		for (const { name, prepare, keeps } of cases) {
			const { dir, target } = await fixture();
			prepare(dir, target);
			const before = fs.readdirSync(dir);
			expect(errorCode(() => writeExportFile(target, Buffer.from("new")))).toBe("EEXIST");
			keeps(dir, target);
			expect(fs.readdirSync(dir), name).toEqual(before);
		}
	});

	test("a creator racing in just before the link keeps its file, and the call fails with EEXIST", async () => {
		const { dir, target } = await fixture();
		spyOn(fs, "linkSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
			fs.writeFileSync(to, "racer");
			nativeLink(from, to);
		});

		expect(errorCode(() => writeExportFile(target, Buffer.from("export")))).toBe("EEXIST");
		expect(fs.readFileSync(target, "utf8")).toBe("racer");
		expect(fs.readdirSync(dir)).toEqual(["chat.html"]);
	});

	test("a link failure leaves no final file and no temporary", async () => {
		const { dir, target } = await fixture();
		spyOn(fs, "linkSync").mockImplementation(() => {
			throw Object.assign(new Error("injected link failure"), { code: "EIO" });
		});

		expect(errorCode(() => writeExportFile(target, Buffer.from("export")))).toBe("EIO");
		expect(fs.existsSync(target)).toBe(false);
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	test("a write failure leaves no final file and no temporary", async () => {
		const { dir, target } = await fixture();
		spyOn(fs, "writeSync").mockImplementation((() => {
			throw Object.assign(new Error("injected write failure"), { code: "EIO" });
		}) as typeof fs.writeSync);

		expect(errorCode(() => writeExportFile(target, Buffer.from("export")))).toBe("EIO");
		expect(fs.existsSync(target)).toBe(false);
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	test("a file fsync failure leaves no final file and no temporary", async () => {
		const { dir, target } = await fixture();
		let linked = false;
		spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
			const path = fdPath(fd);
			if (basename(path).startsWith(`.${basename(target)}.`) && path.endsWith(".tmp")) {
				throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
			}
			nativeFsync(fd);
		});
		spyOn(fs, "linkSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
			linked = true;
			nativeLink(from, to);
		});

		expect(errorCode(() => writeExportFile(target, Buffer.from("export")))).toBe("EIO");
		expect(linked).toBe(false);
		expect(fs.existsSync(target)).toBe(false);
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	test("a zero-progress write fails instead of looping, leaving no final file and no temporary", async () => {
		const { dir, target } = await fixture();
		spyOn(fs, "writeSync").mockImplementation((() => 0) as typeof fs.writeSync);

		expect(() => writeExportFile(target, Buffer.from("export"))).toThrow("no progress writing");
		expect(fs.existsSync(target)).toBe(false);
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	test("short writes are continued until every byte is written", async () => {
		const { target } = await fixture();
		const text = "short writes ✓ ".repeat(40);
		spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number) =>
			nativeWrite(fd, bytes, offset, Math.min(length, 3))) as typeof fs.writeSync);

		writeExportFile(target, Buffer.from(text, "utf8"));

		expect(fs.readFileSync(target, "utf8")).toBe(text);
	});

	test("a directory fsync failure after publication throws and keeps the complete file, with no temporary", async () => {
		const { dir, target } = await fixture();
		const realDir = fs.realpathSync(dir);
		spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
			if (fdPath(fd) === realDir) throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
			nativeFsync(fd);
		});

		expect(errorCode(() => writeExportFile(target, Buffer.from("export")))).toBe("EIO");
		expect(fs.readFileSync(target, "utf8")).toBe("export");
		expect(fs.readdirSync(dir)).toEqual(["chat.html"]);
	});
});
