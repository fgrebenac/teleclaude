import { describe, it, expect } from "vitest";
import { renderDiffHtml, DIFF_HTML_MAX_PATCH_BYTES } from "./diff-render.js";

const SAMPLE_PATCH = `diff --git a/foo.txt b/foo.txt
index 5626abf..f719efd 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,2 +1,2 @@
-old line
+new line
 unchanged line
`;

describe("renderDiffHtml", () => {
  it("returns null for an empty patch", () => {
    expect(renderDiffHtml("", { projectName: "demo", stat: "" })).toBeNull();
  });

  it("returns null when the patch exceeds the byte cap", () => {
    const huge = "+".repeat(DIFF_HTML_MAX_PATCH_BYTES + 1);
    expect(renderDiffHtml(huge, { projectName: "demo", stat: "" })).toBeNull();
  });

  it("renders a real diff into a complete, self-contained document", () => {
    const html = renderDiffHtml(SAMPLE_PATCH, { projectName: "demo-project", stat: "foo.txt | 2 +-" });
    expect(html).not.toBeNull();
    const doc = html!;
    expect(doc).toContain('<meta name="viewport"');
    expect(doc).toContain("demo-project");
    expect(doc).toContain("d2h-file-wrapper");
    // The diff2html CSS bundle was actually loaded and inlined (real dependency,
    // not the empty-string fallback path) — .d2h-wrapper is one of its rules.
    expect(doc).toContain(".d2h-wrapper");
  });

  it("never references an external network resource", () => {
    const html = renderDiffHtml(SAMPLE_PATCH, { projectName: "demo", stat: "" })!;
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("escapes an untrusted project name and stat", () => {
    const html = renderDiffHtml(SAMPLE_PATCH, { projectName: "<script>x</script>", stat: "a<b>.txt | 1 +" })!;
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a&lt;b&gt;.txt");
  });
});
