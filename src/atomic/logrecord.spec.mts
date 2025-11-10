import assert from "assert";
import {
  computeChecksum,
  serializeLogRecord,
  deserializeLogRecord,
} from "../atomic/logrecord.mjs";
import type { LogRecord } from "../atomic/logrecord.mjs";

/**
 * Deze test valideert de functies van logrecord.mts:
 * - checksum berekening
 * - serialisatie en deserialisatie
 * - data-integriteit
 */
function testLogRecord() {
  const data = Buffer.from("Hello SimpleDBMS!");
  const checksum = computeChecksum(data);
  const position = 128;

  const record: LogRecord = { position, data, checksum };

  const checksum2 = computeChecksum(Buffer.from("Hello SimpleDBMS!"));
  assert(checksum.equals(checksum2), "Checksum moet consistent zijn");

  const serialized = serializeLogRecord(record);
  assert(serialized.length === 8 + 32 + data.length, "Bufferlengte klopt niet");

  const recovered = deserializeLogRecord(serialized);

  assert.strictEqual(recovered.position, position, "Foutieve positie");
  assert(recovered.data.equals(data), "Data komt niet overeen");
  assert(recovered.checksum.equals(checksum), "Checksum komt niet overeen");

  console.log("Alle logrecord-tests geslaagd!");
}

if (process.env["VITEST"]) {
  const { describe, it } = await import("vitest");
  describe("logrecord", () => {
    it("computes checksum, serializes and deserializes", () => {
      testLogRecord();
    });
  });
} else {
  process.nextTick(() => {
    testLogRecord();
  });
}
