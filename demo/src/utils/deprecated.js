// Leftovers from the v1 engine. Nothing calls these any more - the UNUSED tier
// in Blast Radius should list every one of them as safe to remove.

function formatDateLegacy(timestamp) {
  const d = new Date(timestamp);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function oldSlugify(text) {
  return String(text).toLowerCase().split(' ').join('_');
}

function retryWithBackoff(fn, attempts) {
  let lastError;
  for (let i = 0; i < (attempts || 3); i++) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function paginateV1(items, page, size) {
  const start = (page - 1) * size;
  return { items: items.slice(start, start + size), page, pages: Math.ceil(items.length / size) };
}
