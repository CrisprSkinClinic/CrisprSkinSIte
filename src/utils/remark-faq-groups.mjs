// Turns question-and-answer groups inside articles into the same accordion used on the FAQ page.
//
// Two ways to write them in an article's Markdown:
//   1. Two or more paragraphs in a row that each start with a bold question:
//        **Can I wax between sessions?** No. The laser needs the hair root...
//   2. Under a "Frequently Asked Questions" heading, each question as a ### heading followed by its answer.
// Everything else is left alone. (src/utils/blogFaq.js reads the same groups to add FAQ structured data.)

const textOf = (n) => (n.value ?? (n.children || []).map(textOf).join('')) || '';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const html = (value) => ({ type: 'html', value });

const DETAILS = '<details class="group ui-card my-3 overflow-hidden open:border-brand-300 open:shadow-lg">';
const summary = (q) =>
  `<summary class="flex cursor-pointer list-none items-center justify-between gap-4 p-5 font-sans text-base font-bold text-slate-900 transition-colors hover:text-brand-700 md:p-6 md:text-lg [&::-webkit-details-marker]:hidden">${esc(q)}` +
  '<span class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700 transition duration-300 group-open:rotate-45 group-open:bg-brand-600 group-open:text-white" aria-hidden="true">' +
  '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span></summary>' +
  '<div class="px-5 pb-6 text-base leading-relaxed text-slate-600 md:px-6">';

const isBoldQuestion = (n) =>
  n.type === 'paragraph' && n.children && n.children.length > 1 && n.children[0].type === 'strong' && /\?\s*$/.test(textOf(n.children[0]));

function boldItem(p) {
  const q = textOf(p.children[0]).trim();
  const rest = p.children.slice(1).map((c) => ({ ...c }));
  if (rest[0] && rest[0].type === 'text') rest[0].value = rest[0].value.replace(/^\s+/, '');
  return [html(DETAILS + summary(q)), { type: 'paragraph', children: rest }, html('</div></details>')];
}

export default function remarkFaqGroups() {
  return (tree) => {
    const kids = tree.children;
    const out = [];
    let i = 0;
    while (i < kids.length) {
      const n = kids[i];
      // Format 2: "Frequently Asked Questions" heading with ### questions.
      if (n.type === 'heading' && n.depth === 2 && /^(frequently asked questions|faqs?|common questions)$/i.test(textOf(n).trim())) {
        let j = i + 1;
        const items = [];
        let cur = null;
        while (j < kids.length && !(kids[j].type === 'heading' && kids[j].depth <= 2)) {
          if (kids[j].type === 'heading' && kids[j].depth === 3) { cur = { q: textOf(kids[j]).trim(), body: [] }; items.push(cur); }
          else if (cur) cur.body.push(kids[j]);
          j++;
        }
        if (items.length >= 2) {
          out.push(n);
          out.push(html('<div class="not-prose my-6">'));
          items.forEach((it) => { out.push(html(DETAILS + summary(it.q)), ...it.body, html('</div></details>')); });
          out.push(html('</div>'));
          i = j;
          continue;
        }
      }
      // Format 1: a run of bold-question paragraphs.
      if (isBoldQuestion(n)) {
        let j = i;
        while (j < kids.length && isBoldQuestion(kids[j])) j++;
        if (j - i >= 2) {
          out.push(html('<div class="not-prose my-6">'));
          for (let k = i; k < j; k++) out.push(...boldItem(kids[k]));
          out.push(html('</div>'));
          i = j;
          continue;
        }
      }
      out.push(n);
      i++;
    }
    tree.children = out;
  };
}
