import type { Post } from "../api/client";
import { readingTime, timeAgo } from "../lib/time";
import { TagList } from "./TagList";

interface PostCardProps {
  post: Post;
  onOpen: (id: number) => void;
}

export function PostCard({ post, onOpen }: PostCardProps) {
  return (
    <article className="post-card" onClick={() => onOpen(post.id)}>
      <h2>{post.heading}</h2>
      <p>{post.blurb}</p>
      <footer>
        <span>{readingTime(post.blurb)}</span>
        {post.createdAt ? <time>{timeAgo(post.createdAt)}</time> : null}
        <TagList tags={post.tags ?? []} />
      </footer>
    </article>
  );
}
