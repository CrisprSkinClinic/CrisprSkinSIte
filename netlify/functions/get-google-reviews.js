// netlify/functions/get-google-reviews.js
//
// Fetches this clinic's live Google reviews server-side using the Places
// API (New) Place Details endpoint, keeping the API key off the client
// entirely -- exposing a Places API key in browser JS would let anyone
// extract it from page source and use it against the clinic's billing
// quota. GOOGLE_PLACES_API_KEY must be set in Netlify env vars.
//
// Places API returns a maximum of 5 reviews per place (a Google-side
// limit, not something this function can work around), and does not let
// you choose which 5 -- Google selects them (typically a mix of recency
// and relevance). This is meant to supplement, not replace, the
// hand-curated per-doctor reviews already in Testimonials.astro.

const PLACE_ID = "ChIJweWcEntnUjoRP7reDooP_tg";

function ok(body, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      // Cache at the CDN edge for a day -- reviews don't change often
      // enough to justify calling Google on every single page load, and
      // this keeps API usage (and cost) predictable regardless of traffic.
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async () => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "GOOGLE_PLACES_API_KEY environment variable is missing." }),
    };
  }

  try {
    const fieldMask = [
      "rating",
      "userRatingCount",
      "googleMapsUri",
      "reviews.rating",
      "reviews.text",
      "reviews.authorAttribution.displayName",
      "reviews.authorAttribution.photoUri",
      "reviews.publishTime",
      "reviews.relativePublishTimeDescription",
    ].join(",");

    const response = await fetch(
      `https://places.googleapis.com/v1/places/${PLACE_ID}`,
      {
        method: "GET",
        headers: {
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": fieldMask,
        },
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("Places API error:", response.status, errorBody);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Could not fetch reviews from Google at this time." }),
      };
    }

    const data = await response.json();

    const reviews = (data.reviews || []).map((r) => ({
      name: r.authorAttribution?.displayName || "Google User",
      photoUri: r.authorAttribution?.photoUri || null,
      rating: r.rating || 5,
      quote: r.text?.text || "",
      relativeTime: r.relativePublishTimeDescription || "",
    }));

    return ok({
      overallRating: data.rating || null,
      totalReviewCount: data.userRatingCount || null,
      mapsUrl: data.googleMapsUri || null,
      reviews,
    });
  } catch (error) {
    console.error("get-google-reviews error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || "Something went wrong fetching reviews." }),
    };
  }
};
