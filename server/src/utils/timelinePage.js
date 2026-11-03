// Cut one page off a deal's merged timeline (newest first).
//
// The route fetches each source — messages, tasks, notes — with LIMIT
// pageSize + 1 and merges them, so `merged` can hold more than a page. This
// takes the newest `pageSize`, then keeps going while the next row shares the
// last row's timestamp: the next page asks for rows strictly BEFORE that
// timestamp, so splitting a group of same-instant rows across the cut would
// drop the rest of the group for good.
//
// A row with no timestamp counts as the epoch, the same as the SQL's
// COALESCE(..., 'epoch'), so the cursor is always a real instant.
//
// Returns { page, hasMore, nextBefore } — nextBefore is the ISO timestamp the
// client sends back as `before`, or null when there is nothing older.

const tsOf = (row) => {
  const v = row?.ts ? new Date(row.ts).getTime() : NaN;
  return Number.isNaN(v) ? 0 : v;
};

export function pageTimeline(merged, pageSize) {
  if (!pageSize || merged.length <= pageSize) {
    return { page: merged, hasMore: false, nextBefore: null };
  }
  let end = pageSize;
  const boundary = tsOf(merged[pageSize - 1]);
  while (end < merged.length && tsOf(merged[end]) === boundary) end++;
  const page = merged.slice(0, end);
  const hasMore = merged.length > end;
  return {
    page,
    hasMore,
    nextBefore: hasMore ? new Date(boundary).toISOString() : null
  };
}
