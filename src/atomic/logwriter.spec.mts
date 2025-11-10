import { describe, test, expect } from "vitest"; 
import { strict as assert } from "node:assert";
import { computeChecksum, serializeLogRecord } from "./logrecord.mjs";
import { writeAndSyncLog } from "./logwriter.mjs";
import type { LogRecord } from "./logrecord.mts";
import { MockFile } from "../core/mockfile.mjs";

describe("writeAndSyncLog", () => {
  test("writes serialized record atomically to file using MockFile", async () => {
    const mockFile = new MockFile(512);

    const data = Buffer.from("Atomic file test!");
    const checksum = computeChecksum(data);
    const record: LogRecord = { position: 128, data, checksum };

    await mockFile.create();
    await mockFile.open();
    await writeAndSyncLog(mockFile, record);
    await mockFile.close();

    const expected = serializeLogRecord(record);
    const stats = await mockFile.stat();
    assert.strictEqual(stats.size, expected.length);

    const buffer = Buffer.alloc(expected.length);
    await mockFile.read(buffer, { position: 0 });

    expect(buffer.equals(expected)).toBe(true);
  });
});
