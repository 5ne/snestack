import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeVerified } from "../../src/core/safeWrite";

describe("writeVerified", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-safewrite-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes the text and reports success", () => {
    const file = path.join(dir, "out.md");
    expect(writeVerified(file, "héllo\n")).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe("héllo\n");
  });

  it("reports a failure (rather than throwing) when the file can't be written", () => {
    expect(writeVerified(path.join(dir, "no-such-dir", "out.md"), "x")).toContain("could not write");
  });
});
