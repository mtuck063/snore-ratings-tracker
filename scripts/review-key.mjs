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
