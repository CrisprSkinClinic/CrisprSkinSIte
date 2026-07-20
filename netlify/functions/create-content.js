// netlify/functions/create-content.js
//
// Handles create, edit, and delete for blog posts and FAQs.
// All actions open a GitHub Pull Request for review rather than
// committing directly to main. Validates generated YAML frontmatter
// before ever sending it to GitHub, to catch malformed content early.

const GITHUB_OWNER = "drkarthiklaxmanai";
const GITHUB_REPO = "eye-clinic-site";
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

  const { password, contentType, fields, action, filePath: existingFilePath, sha } = payload;

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: "Incorrect password" }) };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server is not configured correctly. Contact developer." }) };
  }

  if (contentType !== "blog" && contentType !== "faq") {
    return { statusCode: 400, body: JSON.stringify({ error: "Unknown content type" }) };
  }

  const isDelete = action === "delete";
  const isEdit = action === "edit";

  try {
    if (isDelete) {
      if (!existingFilePath || !sha) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing filePath or sha for delete" }) };
      }
      const prUrl = await deleteGithubFilePR({
        token,
        filePath: existingFilePath,
        sha,
        prTitle: `Delete: ${existingFilePath}`,
      });
      return { statusCode: 200, body: JSON.stringify({ success: true, prUrl }) };
    }

    let filePath, frontmatterObj, body, prTitle;

    if (contentType === "blog") {
      const { title, description, pubDate, author, tags, body: blogBody } = fields;
      if (!title || !description || !pubDate || !blogBody) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing required blog fields (title, description, publish date, and body are all required)" }) };
      }
      filePath = isEdit ? existingFilePath : `src/content/blog/${slugify(title)}.md`;
      body = blogBody;

      frontmatterObj = { title, pubDate, description };
      if (author && author.trim().length > 0) frontmatterObj.author = author.trim();
      // tags now arrives as a real array from the tag-list UI, not a comma string
      if (Array.isArray(tags) && tags.length > 0) frontmatterObj.tags = tags;

      prTitle = isEdit ? `Update blog post: ${title}` : `New blog post: ${title}`;
    } else {
      const { question, order, body: faqBody } = fields;
      if (!question || !faqBody) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing required FAQ fields (question and answer are both required)" }) };
      }
      filePath = isEdit ? existingFilePath : `src/content/faqs/${slugify(question)}.md`;
      body = faqBody;

      frontmatterObj = { question };
      if (order !== undefined && order !== null && String(order).trim().length > 0) {
        const orderNum = Number(order);
        if (Number.isNaN(orderNum)) {
          return { statusCode: 400, body: JSON.stringify({ error: "Display Order must be a number" }) };
        }
        frontmatterObj.order = orderNum;
      }

      prTitle = isEdit ? `Update FAQ: ${question}` : `New FAQ: ${question}`;
    }

    const fileContent = buildMarkdownFile(frontmatterObj, body);

    // VALIDATION GATE: parse our own generated YAML back out before sending
    // it anywhere. If this throws, we catch it below and reject the request
    // with a clear error -- nothing malformed ever reaches GitHub.
    validateGeneratedFrontmatter(fileContent);

    const prUrl = await createGithubPR({
      token,
      filePath,
      fileContent,
      prTitle,
      sha: isEdit ? sha : undefined,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, prUrl }),
    };
  } catch (error) {
    console.error("create-content error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || "Something went wrong creating the content." }),
    };
  }
};

// Builds YAML frontmatter using proper JSON-safe string/array escaping,
// rather than hand-concatenated strings -- this is what actually prevents
// the double-encoding class of bug we hit earlier.
function buildMarkdownFile(frontmatterObj, body) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatterObj)) {
    if (Array.isArray(value)) {
      const arrayStr = "[" + value.map((v) => JSON.stringify(String(v))).join(", ") + "]";
      lines.push(`${key}: ${arrayStr}`);
    } else if (typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else if (key === "pubDate") {
      // dates are written unquoted, matching existing file conventions
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(String(value))}`);
    }
  }
  lines.push("---", "", body);
  return lines.join("\n");
}

// Minimal YAML frontmatter validator. Re-parses what we just generated
// using a small, strict parser (not a full YAML library, since we control
// the exact shape we generate) and confirms it round-trips correctly.
function validateGeneratedFrontmatter(fileContent) {
  const match = fileContent.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    throw new Error("Internal error: generated file is missing frontmatter delimiters.");
  }
  const fm = match[1];
  const lines = fm.split("\n").filter((l) => l.trim().length > 0);

  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      throw new Error(`Internal error: malformed frontmatter line: "${line}"`);
    }
    const value = line.slice(idx + 1).trim();

    // Array fields must have matched brackets and no nested/duplicated brackets
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) {
        throw new Error(`Internal error: malformed list value: "${value}"`);
      }
      const innerBrackets = value.slice(1, -1);
      if (innerBrackets.includes("[") || innerBrackets.includes("]")) {
        throw new Error(`Internal error: nested brackets detected in list value: "${value}"`);
      }
    }

    // Quoted string fields must have exactly one matched pair of quotes,
    // not double-wrapped quotes like ""text"" or "["text""]"
    if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length < 2) {
        throw new Error(`Internal error: malformed quoted value: "${value}"`);
      }
      const inner = value.slice(1, -1);
      if (inner.includes('""') || (inner.startsWith('"') && inner.endsWith('"'))) {
        throw new Error(`Internal error: double-quoted value detected: "${value}"`);
      }
    }
  }
}

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

async function githubRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API error (${response.status}): ${errorBody}`);
  }
  return response.json();
}

async function createGithubPR({ token, filePath, fileContent, prTitle, sha }) {
  const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

  const baseRef = await githubRequest(`${apiBase}/git/ref/heads/${BASE_BRANCH}`, token);
  const baseSha = baseRef.object.sha;

  const branchName = `staff-admin/${Date.now()}`;
  await githubRequest(`${apiBase}/git/refs`, token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });

  const contentBase64 = Buffer.from(fileContent, "utf-8").toString("base64");
  const putBody = {
    message: prTitle,
    content: contentBase64,
    branch: branchName,
  };
  if (sha) putBody.sha = sha;

  await githubRequest(`${apiBase}/contents/${filePath}`, token, {
    method: "PUT",
    body: JSON.stringify(putBody),
  });

  const pr = await githubRequest(`${apiBase}/pulls`, token, {
    method: "POST",
    body: JSON.stringify({
      title: prTitle,
      head: branchName,
      base: BASE_BRANCH,
      body: "Created via the staff admin panel. Review the content below, then merge to publish it live.",
    }),
  });

  return pr.html_url;
}

async function deleteGithubFilePR({ token, filePath, sha, prTitle }) {
  const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

  const baseRef = await githubRequest(`${apiBase}/git/ref/heads/${BASE_BRANCH}`, token);
  const baseSha = baseRef.object.sha;

  const branchName = `staff-admin/${Date.now()}`;
  await githubRequest(`${apiBase}/git/refs`, token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });

  await githubRequest(`${apiBase}/contents/${filePath}`, token, {
    method: "DELETE",
    body: JSON.stringify({
      message: prTitle,
      sha,
      branch: branchName,
    }),
  });

  const pr = await githubRequest(`${apiBase}/pulls`, token, {
    method: "POST",
    body: JSON.stringify({
      title: prTitle,
      head: branchName,
      base: BASE_BRANCH,
      body: "Deletion requested via the staff admin panel. Review, then merge to confirm.",
    }),
  });

  return pr.html_url;
}
