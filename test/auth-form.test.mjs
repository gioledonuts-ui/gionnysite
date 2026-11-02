import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../script.js", import.meta.url), "utf8");

test("visitor login and registration bypass browser pseudo patterns and trim before submit", () => {
  const marker = html.indexOf("data-auth-form");
  assert.notEqual(marker, -1);
  const formStart = html.lastIndexOf("<form", marker);
  const formOpenEnd = html.indexOf(">", marker);
  const formEnd = html.indexOf("</form>", formOpenEnd);
  assert.ok(formStart >= 0 && formOpenEnd > formStart && formEnd > formOpenEnd);
  const formMarkup = html.slice(formStart, formEnd);
  assert.match(html.slice(formStart, formOpenEnd), /\bnovalidate\b/iu);
  assert.doesNotMatch(formMarkup, /\spattern\s*=/iu);

  const submitStart = script.indexOf('authForm?.addEventListener("submit"');
  const submitEnd = script.indexOf('logoutButtons.forEach', submitStart);
  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  const submitHandler = script.slice(submitStart, submitEnd);
  assert.match(submitHandler, /String\(pseudoInput\?\.value \|\| ""\)\.trim\(\)/u);
  assert.doesNotMatch(submitHandler, /reportValidity\(\)/u);
});
