const { stripTags } = require('./format');

function hasTitle(post) {
  return typeof post.title === 'string' && post.title.length > 0;
}

function hasBody(post) {
  return typeof post.body === 'string' && post.body.length > 10;
}

function isValidPost(post) {
  if (!post) {
    return false;
  }
  return hasTitle(post) && hasBody(post);
}

function sanitizePost(post) {
  return {
    title: stripTags(post.title),
    body: stripTags(post.body),
    tags: post.tags || [],
  };
}

function assertPost(post) {
  if (!isValidPost(post)) {
    throw new Error('invalid post');
  }
  return sanitizePost(post);
}

module.exports = { hasTitle, hasBody, isValidPost, sanitizePost, assertPost };
