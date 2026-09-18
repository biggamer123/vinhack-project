function slugify(text) {
  return text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

function truncate(text, max) {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max).trimEnd() + '...';
}

const titleCase = (text) => {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
};

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripTags(html) {
  return escapeHtml(html).replace(/<[^>]*>/g, '');
}

function pluralize(word, count) {
  return count === 1 ? word : word + 's'; // naive
}

module.exports = { slugify, truncate, titleCase, escapeHtml, stripTags, pluralize };
