const { query, withTransaction } = require('./pool');
const { mergeTags } = require('../tags');
const { recordChange } = require('../audit');

async function findPostById(pool, id) {
  const { rows } = await query(pool, 'SELECT * FROM posts WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listPublished(pool, limit, offset) {
  const { rows } = await query(
    pool,
    'SELECT id, title, slug, published_at FROM posts WHERE status = $1 ORDER BY published_at DESC LIMIT $2 OFFSET $3',
    ['published', limit || 20, offset || 0],
  );
  return rows;
}

async function insertPost(pool, post, authorId) {
  recordChange(authorId, 'insert', 'posts');
  return withTransaction(pool, async (run) => {
    const { rows } = await run(
      'INSERT INTO posts (author_id, title, slug, body, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [authorId, post.title, post.slug, post.body, 'draft'],
    );
    await saveTags(run, rows[0].id, mergeTags([], post.tags));
    return rows[0].id;
  });
}

async function saveTags(run, postId, tags) {
  for (const tag of tags) {
    await run('INSERT INTO tags (name) VALUES ($1) ON CONFLICT DO NOTHING', [tag]);
    await run('INSERT INTO post_tags (post_id, tag_name) VALUES ($1, $2)', [postId, tag]);
  }
}

async function updatePost(pool, id, changes, editorId) {
  recordChange(editorId, 'update', `posts/${id}`);
  const { rows } = await query(
    pool,
    'UPDATE posts SET title = COALESCE($2, title), body = COALESCE($3, body), updated_at = now() WHERE id = $1 RETURNING *',
    [id, changes.title, changes.body],
  );
  return rows[0] || null;
}

module.exports = { findPostById, listPublished, insertPost, updatePost };
