import { htmlToPlainText, truncate } from "../../../../src/domains/travel/tools/htmlToPlainText";

describe("htmlToPlainText", () => {
  it("strips tags and converts common block elements to line breaks", () => {
    const html = "<div>Confirmation</div><p>Flight UA123</p>SFO to JFK";
    expect(htmlToPlainText(html)).toBe("Confirmation\nFlight UA123\nSFO to JFK");
  });

  it("removes style and script blocks entirely", () => {
    const html = "<style>.x{color:red}</style><script>track()</script><p>Hotel confirmed</p>";
    expect(htmlToPlainText(html)).toBe("Hotel confirmed");
  });

  it("decodes the common HTML entities", () => {
    const html = "Tom &amp; Jerry&#39;s &quot;Resort&quot; &lt;3 &gt;2 nights&nbsp;stay";
    expect(htmlToPlainText(html)).toBe('Tom & Jerry\'s "Resort" <3 >2 nights stay');
  });

  it("drops href attributes entirely when stripping the surrounding tag", () => {
    const longLink = "https://track.example.com/" + "a".repeat(100);
    const html = `<a href="${longLink}">Click here</a> Flight confirmed`;
    const result = htmlToPlainText(html);
    expect(result).not.toContain(longLink);
    expect(result).toContain("Click here");
    expect(result).toContain("Flight confirmed");
  });

  it("collapses a long unbroken token that appears in visible text (not inside a tag) to a placeholder", () => {
    const longToken = "a".repeat(100);
    const html = `<p>See tracking id ${longToken} for details</p>`;
    const result = htmlToPlainText(html);
    expect(result).toContain("[long link omitted]");
    expect(result).not.toContain(longToken);
    expect(result).toContain("See tracking id");
    expect(result).toContain("for details");
  });

  it("collapses excess blank lines", () => {
    const html = "<p>A</p>\n\n\n\n<p>B</p>";
    expect(htmlToPlainText(html)).toBe("A\n\nB");
  });
});

describe("truncate", () => {
  it("leaves short text untouched", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("cuts long text to the budget and marks it truncated", () => {
    const result = truncate("a".repeat(20), 5);
    expect(result).toBe("aaaaa\n[truncated]");
  });
});
