/** Geometry shared by the chat viewport and its regression tests. */
export const FOLLOW_THRESHOLD_PX = 96;

export function distanceFromBottom(scrollHeight: number, clientHeight: number, scrollTop: number): number {
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

export function nearChatBottom(scrollHeight: number, clientHeight: number, scrollTop: number): boolean {
  return distanceFromBottom(scrollHeight, clientHeight, scrollTop) <= FOLLOW_THRESHOLD_PX;
}

export function restoredPrependTop(previousTop: number, previousHeight: number, nextHeight: number): number {
  return Math.max(0, previousTop + nextHeight - previousHeight);
}
