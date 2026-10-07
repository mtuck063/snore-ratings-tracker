// The one key both review sources share. The RSS feed and App Store Connect
// disagree about a review's UTC offset only: both stamp it with the same
// Cupertino wall clock, but the feed writes every one -07:00 while the API
// uses the offset actually in force, so anything written in winter differs by
// an hour once parsed -- 26 of 88 reviews when this was first noticed, all of
// them PST. Comparing the first 19 characters compares the wall clock and
// sidesteps it. The storefront and the star rating break the ties: two
// reviews in one storefront sharing a second and a rating do not happen. The
// nickname used to do that job and cannot, because a reviewer can change it
// -- one did, between the feed's copy and the API's, and the review was
// stored twice. The RSS id and the App Store Connect id are unrelated
// numbers, so neither can be the key.
export const joinKey = (date, cc, rating) => `${String(date).slice(0, 19)}|${cc}|${rating}`;

// A review App Store Connect delivered before the RSS feed did carries the
// API's id under this prefix until the feed catches up and the collector
// swaps in the feed's own id.
export const API_ID_PREFIX = "asc:";

// Apple keeps one review per reviewer per app, so a reviewer who writes again
// replaces the earlier review: it leaves the feed and the API listing the way
// a deleted one does, while its star stays in the count. The nickname is the
// only thread between the two, so a live review written later in the same
// storefront under the same nickname marks the earlier one replaced. A
// reviewer who changes nickname in the same edit breaks the thread, and the
// old review then reads as removed.
export const findReplacement = (r, reviews) =>
  r.author
    ? reviews.find(
        (o) => o !== r && !o.removed && o.cc === r.cc && o.author === r.author && new Date(o.date) > new Date(r.date)
      ) ?? null
    : null;

// The replacement can reach the store after the old review's removal was
// already logged. Its event is then withdrawn, matched on the fields the
// event carries, since events hold no review id.
export const isRemovalEventFor = (ev, r) =>
  ev.type === "review-removed" && ev.cc === r.cc && ev.rating === r.rating && ev.title === r.title.slice(0, 80);
