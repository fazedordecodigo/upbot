import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../src/ui/icons";

test("sprite icons use the public asset and stay decorative", () => {
  const markup = renderToStaticMarkup(<Icon name="plus" />);
  expect(markup).toContain('class="od-icon"');
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).toContain('href="/assets/icons.svg#i-plus"');
});

test("sprite icons append optional classes without an empty class", () => {
  expect(renderToStaticMarkup(<Icon name="x" className="custom" />)).toContain(
    'class="od-icon custom"',
  );
  expect(renderToStaticMarkup(<Icon name="x" className="" />)).toContain('class="od-icon"');
});
