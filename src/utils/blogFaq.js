// Finds the question-and-answer groups written inside an article's Markdown, so the page can describe them to
// search engines (FAQ structured data). Mirrors the two formats handled by remark-faq-groups.mjs.
const plain = (s) =>
  String(s)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function extractFaqs(markdown) {
  const text = String(markdown || '');
  const pairs = [];

  // Format 1: runs of two or more blocks that each start with a bold question.
  const blocks = text.split(/\n\s*\n/);
  let run = [];
  const flush = () => { if (run.length >= 2) pairs.push(...run); run = []; };
  for (const b of blocks) {
    const m = b.trim().match(/^\*\*([^*\n]+\?)\*\*\s+([\s\S]+)$/);
    if (m) run.push({ question: plain(m[1]), answer: plain(m[2]) });
    else flush();
  }
  flush();

  // Format 2: "## Frequently Asked Questions" followed by ### questions.
  const sec = text.match(/^## (?:Frequently Asked Questions|FAQs?|Common Questions)\s*\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/im);
  if (sec) {
    const parts = sec[1].split(/^### /m).slice(1);
    const found = parts.map((p) => {
      const [q, ...rest] = p.split('\n');
      return { question: plain(q), answer: plain(rest.join(' ')) };
    }).filter((x) => x.question && x.answer);
    if (found.length >= 2) pairs.push(...found.filter((f) => !pairs.some((p) => p.question === f.question)));
  }
  return pairs;
}
