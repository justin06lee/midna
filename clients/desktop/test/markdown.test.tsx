import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, inline } from "../src/markdown";

const html = (text: string) => renderToStaticMarkup(<>{inline(text)}</>);

describe("what midna writes inside a line", () => {
  test("italic with asterisks or underscores, bold, struck, code and links", () => {
    expect(html("Reading: *Justice*, chapter 4")).toBe("Reading: <em>Justice</em>, chapter 4");
    expect(html("an _aside_ here")).toBe("an <em>aside</em> here");
    expect(html("**Done** and ~~dropped~~")).toBe("<strong>Done</strong> and <s>dropped</s>");
    expect(html("run `make *.o` now")).toBe("run <code>make *.o</code> now");
    expect(html("see [the *docs*](https://example.com/a)")).toBe('see <a title="https://example.com/a">the <em>docs</em></a>');
    expect(html("**bold with `code` and *italic***")).toBe("<strong>bold with <code>code</code> and <em>italic</em></strong>");
    expect(html("*a*")).toBe("<em>a</em>");
  });

  test("asterisks that aren't emphasis stay as written", () => {
    expect(html("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(html("*.png and *.jpg")).toBe("*.png and *.jpg");
    expect(html("a * b")).toBe("a * b");
    expect(html("snake_case_name")).toBe("snake_case_name");
  });

  test("the same holds inside a list item and a table's cell", () => {
    const out = renderToStaticMarkup(<Markdown text={"- Reading: *Justice*, **ch. 4**, `p.12`, [link](https://x.y)\n\n| What | When |\n| --- | --- |\n| *soon* | **now** `x` [l](https://x.y) |"} />);
    expect(out).toContain("<li>Reading: <em>Justice</em>, <strong>ch. 4</strong>, <code>p.12</code>, <a title=\"https://x.y\">link</a></li>");
    expect(out).toContain("<td style=\"text-align:left\"><em>soon</em></td>");
    expect(out).toContain("<strong>now</strong> <code>x</code> <a title=\"https://x.y\">l</a></td>");
  });

  test("a code block carries a Copy button", () => {
    const out = renderToStaticMarkup(<Markdown text={"```sh\ngit pull\n```"} />);
    expect(out).toContain('<div class="md-code"><pre>git pull</pre><button type="button">Copy</button></div>');
  });
});
