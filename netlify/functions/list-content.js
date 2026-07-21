// netlify/functions/list-content.js
//
// Lists existing blog posts or FAQs, and fetches one file's full content
// for editing. Read-only.

const GITHUB_OWNER = "CrisprSkinClinic";
const GITHUB_REPO = "CrisprSkinSIte";
const BASE_BRANCH = "main";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { password, contentType, action, filePath } = payload;

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: "Incorrect password" }) };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server is not configured correctly." }) };
  }

  if (contentType !== "blog" && contentType !== "faq" && contentType !== "testimonial") {
    return { statusCode: 400, body: JSON.stringify({ error: "Unknown content type" }) };
  }

  const folder =
    contentType === "blog" ? "src/content/blog"
    : contentType === "faq" ? "src/content/faqs"
    : "src/content/testimonials";

  try {
    if (action === "list") {
      const files = await githubRequest(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${folder}?ref=${BASE_BRANCH}`,
        token
      );
      const items = files
        .filter((f) => f.name.endsWith(".md"))
        .map((f) => ({ name: f.name, path: f.path }));
      return { statusCode: 200, body: JSON.stringify({ items }) };
    }

    if (action === "get") {
      if (!filePath) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing filePath" }) };
      }
      const file = await githubRequest(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}?ref=${BASE_BRANCH}`,
        token
      );
      const content = Buffer.from(file.content, "base64").toString("utf-8");
      return { statusCode: 200, body: JSON.stringify({ content, sha: file.sha }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: "Unknown action" }) };
  } catch (error) {
    console.error("list-content error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message || "Something went wrong." }) };
  }
};

async function githubRequest(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API error (${response.status}): ${errorBody}`);
  }
  return response.json();
}
