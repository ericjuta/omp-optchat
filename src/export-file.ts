import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

/**
 * Publishes `bytes` at `path` only when nothing exists there. The bytes go to a private temp in the same
 * directory (created exclusively, mode 0600), are fsynced, then hard-linked to `path`. link(2) fails with
 * EEXIST rather than replacing any existing entry: a file, symlink, directory or racing creator is kept.
 * The temp name is then unlinked. The directory is fsynced after the link and after the unlink. On any
 * failure, only this call's temp is removed; an existing target is never touched.
 */
export function writeExportFile(path: string, bytes: Buffer): void {
	const directory = dirname(path);
	const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
	const fd = openSync(temporary, "wx", 0o600);
	let fileOpen = true;
	let temporaryExists = true;
	try {
		let written = 0;
		while (written < bytes.length) {
			const count = writeSync(fd, bytes, written, bytes.length - written);
			if (count <= 0) throw new Error(`no progress writing ${temporary}`);
			written += count;
		}
		fsyncSync(fd);
		fileOpen = false;
		closeSync(fd);
		linkSync(temporary, path);
		fsyncDirectory(directory);
		unlinkSync(temporary);
		temporaryExists = false;
		fsyncDirectory(directory);
	} finally {
		// Cleanup is best effort: the original error is the one to report.
		if (fileOpen) {
			try {
				closeSync(fd);
			} catch {}
		}
		if (temporaryExists) {
			try {
				unlinkSync(temporary);
			} catch {}
		}
	}
}

export function fsyncDirectory(directory: string): void {
	const fd = openSync(directory, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
