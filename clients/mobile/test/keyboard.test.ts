import { expect, test } from "bun:test";
import { keyboardLift } from "../src/keyboard";

const win = 852;
const base = { viewTop: 110, viewBottom: win, windowHeight: win };

test("the lift is what the keyboard covers of the view", () => {
  expect(keyboardLift({ ...base, keyboardTop: 852 - 336, keyboardHeight: 336 })).toBe(336);
  // A view that ends above a tab bar is covered by less.
  expect(keyboardLift({ ...base, viewBottom: win - 80, keyboardTop: 852 - 336, keyboardHeight: 336 })).toBe(256);
});

test("no keyboard, or one off screen, lifts nothing", () => {
  expect(keyboardLift({ ...base, keyboardTop: win, keyboardHeight: 0 })).toBe(0);
  expect(keyboardLift({ ...base, keyboardTop: win, keyboardHeight: 336 })).toBe(0);
});

test("the same frame twice gives the same lift (nothing accumulates)", () => {
  const f = { ...base, keyboardTop: 852 - 336, keyboardHeight: 336 };
  expect(keyboardLift(f)).toBe(keyboardLift(f));
});

test("never more than the keyboard, nor than leaves room for the header", () => {
  expect(keyboardLift({ ...base, keyboardTop: 0, keyboardHeight: 336 })).toBe(336);
  expect(keyboardLift({ ...base, keyboardTop: 300, keyboardHeight: 900 })).toBe(552);
  expect(keyboardLift({ viewTop: 110, viewBottom: 400, keyboardTop: 120, keyboardHeight: 336, windowHeight: win })).toBe(170);
});

test("bad numbers lift nothing", () => {
  expect(keyboardLift({ ...base, keyboardTop: NaN, keyboardHeight: 336 })).toBe(0);
});
