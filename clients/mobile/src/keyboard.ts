/** The header and a little message list always stay above the lift. */
const KEEP = 120;

/**
 * How far to raise the bottom of a view so the keyboard doesn't cover it.
 * `viewTop`/`viewBottom` are the view's own frame in the window (padding
 * doesn't move it, so the lift already applied is not part of it);
 * `keyboardTop` is where the keyboard starts. Never more than the keyboard
 * is tall, nor more than leaves the view `KEEP` points: a stale or odd
 * frame (an app coming back from the background) can't throw the layout.
 */
export function keyboardLift(f: { viewTop: number; viewBottom: number; keyboardTop: number; keyboardHeight: number; windowHeight: number }): number {
  const { viewTop, viewBottom, keyboardTop, keyboardHeight, windowHeight } = f;
  if (![viewTop, viewBottom, keyboardTop, keyboardHeight, windowHeight].every(Number.isFinite)) return 0;
  if (keyboardHeight <= 0 || keyboardTop >= windowHeight) return 0;
  const room = Math.max(0, viewBottom - viewTop - KEEP);
  return Math.min(Math.max(0, viewBottom - keyboardTop), keyboardHeight, room);
}
